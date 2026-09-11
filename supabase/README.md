# VITA — Backend Supabase

Schema e políticas de segurança para o sistema **VITA — Automação de Produção/Faturamento**.

## Como aplicar

Com a [Supabase CLI](https://supabase.com/docs/guides/cli) instalada e o projeto já criado no painel:

```bash
supabase link --project-ref <seu-project-ref>
supabase db push
```

Isso aplica, em ordem, os arquivos em `migrations/`:

1. `0001_init_schema.sql` — tabelas de convênios, censo, processamentos, pacientes, memória de cálculo, pendências e exportações.
2. `0002_rls.sql` — Row Level Security em todas as tabelas.
3. `0003_storage.sql` — buckets privados `censos` e `relatorios`.

Não há dados de exemplo para carregar — o banco sobe vazio de propósito. Os
convênios reais (nome, periodicidade, valor da diária, regras por evento) são
cadastrados pelo próprio usuário na tela **Configuração de Convênios** do app,
que já grava direto nessas tabelas.

## Passos manuais no painel do Supabase (uma vez só)

- **Authentication → Providers**: o app tem uma tela de cadastro público
  ("Criar conta"), então este toggle ("Allow new users to sign up") precisa
  estar **ativado** para ela funcionar — veja o aviso de segurança abaixo
  antes de decidir. Se preferir voltar ao modelo original (só admin cria
  conta, via Authentication → Users → Add user), é só desativar este toggle.
- Nenhum outro passo manual é necessário — buckets e políticas já vêm das migrations.

## Modelo de dados (visão geral)

```
convenios ──< convenio_valores_vigencia   (histórico de valor da diária; sem sobreposição)
          ──< convenio_regras_evento      (1:1 — alta/óbito/transferência/ausência)

censo_uploads ──< processamentos ──< processamento_pacientes ──< memoria_calculo_diaria
                                                              └─< pendencias

processamentos ──< exportacoes
```

- **`convenio_valores_vigencia`** tem uma restrição `exclude using gist` que impede duas vigências de valor se sobreporem para o mesmo convênio — a vigência atual é a linha com `vigencia_fim is null`.
- **`pendencias`** tem um `check` que impede marcar uma pendência como `resolvida` sem `acao` e `justificativa` preenchidos — a mesma regra que a tela de Resolução de Pendências aplica na interface.
- **`exportacoes.tipo`** distingue `faturamento` (relatório limpo) de `pendencias` (relatório de auditoria com justificativas) — são sempre arquivos separados, nunca o mesmo `storage_path`.
- Arquivos brutos de censo vão no bucket `censos`; os relatórios exportados (Excel/PDF), no bucket `relatorios`. Ambos são privados — o acesso passa sempre pela API do Supabase com o usuário autenticado.

## Segurança (RLS)

As políticas em `0002_rls.sql` liberam CRUD completo em todas as tabelas de negócio (convênios, censos, processamentos, pacientes, memória de cálculo, pendências, exportações) para **qualquer usuário autenticado** — não existe diferenciação de papel/role hoje. Essa política foi desenhada originalmente assumindo que só o administrador criava contas (cadastro fechado), então "autenticado" era sinônimo de "funcionário aprovado".

**Atenção — isso mudou:** o app agora tem uma tela de cadastro público (qualquer pessoa cria a própria conta, sem aprovação). Combinado com o RLS acima, isso significa que **qualquer pessoa que ache o link do sistema e crie uma conta passa a ter acesso total de leitura e escrita a todos os dados de faturamento e pacientes** — não só ver, mas também editar convênios, resolver pendências e exportar relatórios. Se esse não for o comportamento desejado, as opções são:

1. Desativar "Allow new users to sign up" de novo (volta ao cadastro fechado, sem mudar nada no código) — mais simples.
2. Manter o cadastro público, mas restringir o RLS: adicionar uma coluna `role` (ou `aprovado boolean default false`) em `profiles`, e trocar `to authenticated` pelas checagens correspondentes nas políticas de `0002_rls.sql`, de forma que uma conta recém-criada só ganhe acesso às tabelas de negócio depois de aprovada por um admin.
3. Restringir por domínio de e-mail (ex.: só `@vita.org.br`) usando um Auth Hook do Supabase antes do `signUp` completar.

Nenhuma dessas está implementada — a decisão de qual caminho seguir (ou nenhum, se o link do sistema simplesmente nunca for divulgado publicamente) é do dono do projeto.
