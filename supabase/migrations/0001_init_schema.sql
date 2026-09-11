-- VITA — Automação de Produção/Faturamento
-- Schema inicial: convênios, censos, processamentos, pacientes, memória de cálculo,
-- pendências e exportações.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- =========================================================================
-- PERFIS (usuários criados pelo administrador via Supabase Auth; sem cadastro público)
-- =========================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  cargo text not null default 'Financeiro',
  criado_em timestamptz not null default now()
);

comment on table public.profiles is 'Perfil de cada usuário interno. Contas são criadas pelo administrador (Supabase Auth) — não há cadastro público.';

-- Cria o perfil automaticamente quando um usuário é criado no Auth (via convite/admin).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, nome, cargo)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'nome', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'cargo', 'Financeiro')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================================
-- CONVÊNIOS
-- =========================================================================

create table public.convenios (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  periodicidade text not null check (periodicidade in ('mensal_calendario', 'mensal_21_20', 'semanal')),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on column public.convenios.periodicidade is
  'mensal_calendario = fecha do dia 1 ao último dia do mês; mensal_21_20 = fecha do dia 21 do mês anterior a 20 do mês corrente; semanal = fecha semanalmente.';

create function public.set_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

create trigger trg_convenios_atualizado_em
  before update on public.convenios
  for each row execute function public.set_atualizado_em();

-- Histórico de vigência do valor da diária por convênio.
-- Um intervalo aberto (vigencia_fim = null) representa o valor vigente atual.
create table public.convenio_valores_vigencia (
  id uuid primary key default gen_random_uuid(),
  convenio_id uuid not null references public.convenios (id) on delete cascade,
  valor_diaria numeric(10, 2) not null check (valor_diaria > 0),
  vigencia_inicio date not null,
  vigencia_fim date,
  criado_em timestamptz not null default now(),
  check (vigencia_fim is null or vigencia_fim >= vigencia_inicio),
  exclude using gist (
    convenio_id with =,
    daterange(vigencia_inicio, coalesce(vigencia_fim, 'infinity'::date), '[]') with &&
  )
);

comment on table public.convenio_valores_vigencia is
  'Histórico de valores da diária por convênio. A restrição de exclusão impede duas vigências sobrepostas para o mesmo convênio.';

-- Regras de faturamento por evento — uma linha por convênio.
create table public.convenio_regras_evento (
  convenio_id uuid primary key references public.convenios (id) on delete cascade,
  alta_conta_ultima_diaria boolean not null default true,
  obito_conta_ultima_diaria boolean not null default true,
  transferencia_conta_ultima_diaria boolean not null default false,
  ausencia_conta_ultima_diaria boolean not null default false,
  ausencia_tolerancia_horas integer not null default 24 check (ausencia_tolerancia_horas >= 0)
);

comment on table public.convenio_regras_evento is
  'Regras de faturamento por tipo de evento (alta, óbito, transferência, ausência) para cada convênio.';

-- =========================================================================
-- CENSO (upload do arquivo bruto contínuo)
-- =========================================================================

create table public.censo_uploads (
  id uuid primary key default gen_random_uuid(),
  nome_arquivo text not null,
  storage_path text not null,
  tamanho_bytes bigint,
  abas_detectadas integer not null default 0,
  periodo_inicio date,
  periodo_fim date,
  dias_faltantes date[] not null default '{}',
  enviado_por uuid references public.profiles (id),
  enviado_em timestamptz not null default now()
);

comment on column public.censo_uploads.dias_faltantes is
  'Datas dentro do período identificado para as quais nenhuma aba foi encontrada no arquivo — usado para alertar o usuário antes do processamento.';

-- =========================================================================
-- PROCESSAMENTOS (uma apuração de faturamento = convênio + período)
-- =========================================================================

create table public.processamentos (
  id uuid primary key default gen_random_uuid(),
  censo_upload_id uuid references public.censo_uploads (id),
  convenio_id uuid not null references public.convenios (id),
  competencia text not null,
  periodo_inicio date not null,
  periodo_fim date not null,
  status text not null default 'em_processamento'
    check (status in ('em_processamento', 'concluido', 'concluido_com_pendencias')),
  total_pacientes integer not null default 0,
  total_diarias_faturaveis integer not null default 0,
  total_diarias_pendentes integer not null default 0,
  valor_total_confirmado numeric(12, 2) not null default 0,
  processado_por uuid references public.profiles (id),
  processado_em timestamptz not null default now(),
  check (periodo_fim >= periodo_inicio)
);

comment on column public.processamentos.competencia is 'Competência de referência, formato AAAA-MM (ex.: 2026-09).';

create index idx_processamentos_convenio on public.processamentos (convenio_id);
create index idx_processamentos_competencia on public.processamentos (competencia);

-- Faturamento por paciente dentro de um processamento.
create table public.processamento_pacientes (
  id uuid primary key default gen_random_uuid(),
  processamento_id uuid not null references public.processamentos (id) on delete cascade,
  nome_paciente text not null,
  diarias_faturaveis integer not null default 0,
  diarias_pendentes integer not null default 0,
  valor numeric(12, 2) not null default 0,
  nivel_confianca text not null
    check (nivel_confianca in ('alta_confianca', 'revisao_recomendada', 'bloqueado'))
);

create index idx_processamento_pacientes_processamento on public.processamento_pacientes (processamento_id);

-- Memória de cálculo diária — o detalhamento dia a dia que sustenta o valor de cada paciente.
create table public.memoria_calculo_diaria (
  id uuid primary key default gen_random_uuid(),
  processamento_paciente_id uuid not null references public.processamento_pacientes (id) on delete cascade,
  data date not null,
  status_dia text not null,
  faturavel text not null check (faturavel in ('sim', 'nao', 'pendente', 'bloqueado')),
  regra_aplicada text not null,
  valor numeric(10, 2)
);

create index idx_memoria_calculo_paciente on public.memoria_calculo_diaria (processamento_paciente_id, data);

-- =========================================================================
-- PENDÊNCIAS (casos bloqueados que exigem decisão manual)
-- =========================================================================

create table public.pendencias (
  id uuid primary key default gen_random_uuid(),
  processamento_paciente_id uuid not null references public.processamento_pacientes (id) on delete cascade,
  data_referencia text not null,
  motivo text not null,
  severidade text not null check (severidade in ('alta', 'media', 'baixa')),
  status text not null default 'aberta' check (status in ('aberta', 'resolvida')),
  acao text check (acao in ('faturar', 'nao_faturar')),
  justificativa text,
  resolvido_por uuid references public.profiles (id),
  resolvido_em timestamptz,
  criado_em timestamptz not null default now(),
  check (
    status = 'aberta'
    or (acao is not null and justificativa is not null and length(trim(justificativa)) > 0)
  )
);

comment on column public.pendencias.data_referencia is
  'Data (ou intervalo de datas, em texto livre) a que a pendência se refere — ex.: "15/09/2026" ou "10/09/2026 – 13/09/2026".';
-- Nota: o check acima (status = 'aberta' ou ação+justificativa preenchidas) é
-- a mesma regra que a tela de Resolução de Pendências aplica na interface —
-- não é possível marcar uma pendência como resolvida sem ação e justificativa.

create index idx_pendencias_paciente on public.pendencias (processamento_paciente_id);
create index idx_pendencias_status on public.pendencias (status);

-- =========================================================================
-- EXPORTAÇÕES (relatório de faturamento x relatório de pendências/auditoria)
-- =========================================================================

create table public.exportacoes (
  id uuid primary key default gen_random_uuid(),
  processamento_id uuid not null references public.processamentos (id) on delete cascade,
  tipo text not null check (tipo in ('faturamento', 'pendencias')),
  formato text not null check (formato in ('excel', 'pdf')),
  storage_path text not null,
  gerado_por uuid references public.profiles (id),
  gerado_em timestamptz not null default now()
);

comment on table public.exportacoes is
  'Registro de cada relatório gerado. tipo=faturamento é o relatório limpo para faturamento; tipo=pendencias é o relatório de auditoria com as justificativas — nunca são o mesmo arquivo.';

create index idx_exportacoes_processamento on public.exportacoes (processamento_id);
