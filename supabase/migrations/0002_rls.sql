-- VITA — Automação de Produção/Faturamento
-- RLS: o sistema é de uso interno, sem cadastro público. Todo usuário autenticado
-- é criado pelo administrador e tem o mesmo nível de acesso operacional (setor
-- financeiro), então as políticas liberam CRUD completo para qualquer usuário
-- autenticado nas tabelas de negócio, e restringem "profiles" à leitura coletiva
-- e escrita apenas do próprio registro.

alter table public.profiles enable row level security;
alter table public.convenios enable row level security;
alter table public.convenio_valores_vigencia enable row level security;
alter table public.convenio_regras_evento enable row level security;
alter table public.censo_uploads enable row level security;
alter table public.processamentos enable row level security;
alter table public.processamento_pacientes enable row level security;
alter table public.memoria_calculo_diaria enable row level security;
alter table public.pendencias enable row level security;
alter table public.exportacoes enable row level security;

-- ---- profiles -------------------------------------------------------------
-- Qualquer usuário autenticado pode ver os nomes dos colegas (ex.: "processado
-- por", "resolvido por"), mas só pode alterar o próprio registro. Inserção é
-- feita apenas pelo trigger handle_new_user (security definer), nunca pelo cliente.

create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---- tabelas de negócio: acesso completo para qualquer usuário autenticado ----
-- Configuração de convênios é explicitamente de "acesso livre para o usuário
-- operador, sem aprovação externa" — não há um papel de aprovador separado.

create policy "convenios_all_authenticated"
  on public.convenios for all
  to authenticated
  using (true) with check (true);

create policy "convenio_valores_vigencia_all_authenticated"
  on public.convenio_valores_vigencia for all
  to authenticated
  using (true) with check (true);

create policy "convenio_regras_evento_all_authenticated"
  on public.convenio_regras_evento for all
  to authenticated
  using (true) with check (true);

create policy "censo_uploads_all_authenticated"
  on public.censo_uploads for all
  to authenticated
  using (true) with check (true);

create policy "processamentos_all_authenticated"
  on public.processamentos for all
  to authenticated
  using (true) with check (true);

create policy "processamento_pacientes_all_authenticated"
  on public.processamento_pacientes for all
  to authenticated
  using (true) with check (true);

create policy "memoria_calculo_diaria_all_authenticated"
  on public.memoria_calculo_diaria for all
  to authenticated
  using (true) with check (true);

create policy "pendencias_all_authenticated"
  on public.pendencias for all
  to authenticated
  using (true) with check (true);

create policy "exportacoes_all_authenticated"
  on public.exportacoes for all
  to authenticated
  using (true) with check (true);
