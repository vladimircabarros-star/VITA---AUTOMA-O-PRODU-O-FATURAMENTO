# VITA — Automação de Produção/Faturamento (app real)

Este é o app funcional, sem simulação: login real (Supabase Auth), upload real
do censo (.xlsx), leitura real do arquivo no navegador, motor de cálculo real
do faturamento, e leitura/gravação real no Supabase (convênios, processamentos,
pacientes, memória de cálculo, pendências e exportações).

Não tem build (sem Node, sem bundler) — é HTML/CSS/JS puro. Funciona abrindo
os arquivos num servidor estático qualquer.

## Por que isso é um projeto separado do protótipo em Artifact

O Artifact do Claude roda numa sandbox que bloqueia toda chamada de rede para
fora do próprio domínio do Claude — então é fisicamente impossível ele
conversar com o seu projeto Supabase. Este app aqui é HTML/JS comum, sem essa
restrição: rodando num navegador de verdade (local ou publicado), ele fala
direto com o Supabase.

## 1. Configurar o Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Rode as migrations SQL que já foram entregues (pasta `supabase/` enviada
   anteriormente): `0001_init_schema.sql`, `0002_rls.sql`, `0003_storage.sql`
   — pelo SQL Editor do painel (cole e rode cada um, nessa ordem) ou via
   `supabase db push` com a CLI.
3. Em **Authentication → Providers**, confirme que "Allow new users to sign
   up" está **ativado** — o app agora tem cadastro público (tela "Criar
   conta" no login), então esse toggle precisa estar ligado para funcionar.
   Se preferir voltar a exigir criação manual pelo admin, desative-o aqui —
   a tela de cadastro do app simplesmente vai receber o erro do Supabase
   dizendo que cadastros estão desativados.
4. Em **Authentication → Settings**, "Confirm email" controla se quem se
   cadastra precisa clicar num link no e-mail antes de conseguir entrar
   (recomendado deixar ligado). O app já trata os dois casos.
5. Em **Project Settings → API**, copie a **Project URL** e a **anon/public
   key**.

Se quiser criar um usuário manualmente mesmo com o cadastro público
disponível (ex.: para um cargo diferente), ainda dá pra usar
**Authentication → Users → Add user**, preenchendo em *User Metadata*:
```json
{ "nome": "Paulo Soares", "cargo": "Financeiro" }
```

O banco sobe vazio — não há convênio nenhum pré-cadastrado. Cadastre os
convênios reais do hospital pela tela **Configuração de Convênios** do
próprio app, já com login feito.

## 2. Configurar o app

Edite [`config.js`](config.js):

```js
window.VITA_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'ey...'
};
```

A anon key é segura para expor no frontend (é assim que todo app Supabase
funciona — a segurança real está nas políticas de RLS). **Nunca** coloque a
`service_role key` aqui.

## 3. Rodar

Qualquer servidor estático serve (não abra `index.html` direto com
duplo-clique — alguns navegadores bloqueiam certas chamadas em `file://`):

```bash
npx serve .
# ou: python -m http.server 8080
```

## 4. Publicar

O jeito mais simples, sem instalar nada: arraste a pasta `vita-app` inteira
para [app.netlify.com/drop](https://app.netlify.com/drop) — gera uma URL em
segundos. Vercel e GitHub Pages também funcionam (é só HTML/CSS/JS estático).

---

## Como o motor de cálculo interpreta o censo

O parser (`js/xlsx-reader.js`) foi construído a partir de um arquivo real de
censo (`CENSO MENSAL_AGOSTO_01 a 31.08.2026.xlsx`), não de um formato
inventado. Ele espera:

- Uma aba por dia, com o título da linha 1 no formato
  `CENSO <MÊS> <ANO> - DD/MM/AAAA` (a data vem daí, não do nome da aba).
- Uma linha de cabeçalho com as colunas **LEITO, NOME, PROCEDIMENTO, IDADE,
  DN, ADMISSÃO, DIH, CONVÊNIO, STATUS PALIAÇÃO, ACOMPANHANTE, OBSERVAÇÃO,
  CONTATO** (a ordem das colunas pode variar — o parser localiza cada uma
  pelo texto do cabeçalho, não pela posição).
- Uma linha por leito ocupado; leitos vazios (sem nome) são ignorados.
- Uma seção **LEGENDA** ao final de cada aba, que encerra a tabela de
  pacientes.

### A cor da linha é o sinal principal do evento do dia

O arquivo real não usa uma coluna de "status" — ele destaca a linha inteira
com uma cor de preenchimento quando há um evento, e mantém uma legenda igual
em todas as abas:

| Cor (ARGB)  | Evento          |
|-------------|-----------------|
| `FF00B0F0`  | Admissão        |
| `FF00B050`  | Alta            |
| `FFFF0000`  | Óbito           |
| `FFFFFF00`  | Transferência   |
| `FFFFC000`  | Ausente         |

O parser lê essa legenda de dentro de cada aba (robusto a pequenas variações
de cor entre meses); se não achar, cai para essas cores padrão. **A cor vem
da célula da coluna NOME** — a coluna LEITO tem uma cor "zebrada" própria, sem
relação com eventos, que é ignorada.

### A data real do evento vem do texto da OBSERVAÇÃO, não da aba

No arquivo real, um evento ocorrido em 31/07 aparece destacado na aba do dia
**01/08** (a aba do dia seguinte), com o texto da OBSERVAÇÃO dizendo a data
exata (ex.: `"ALTA EM 31/07/2026 AS 17:30"`). O motor de cálculo
(`js/billing-engine.js`) sempre tenta extrair essa data explícita do texto
primeiro; **só usa "dia anterior ao da aba" como estimativa** quando o texto
não traz nenhuma data — e nesse caso o dia cai automaticamente em REVISÃO
RECOMENDADA em vez de ser tratado como certeza.

### Confiança e pendências

- **ALTA CONFIANÇA**: todos os dias do paciente no período têm um sinal claro
  (presença normal, ou evento com data explícita no texto).
- **REVISÃO RECOMENDADA**: falta a aba de um dia no meio do período, ou a
  data de um evento teve que ser estimada por falta de data explícita no
  texto.
- **BLOQUEADO** (vai para a tela de Resolução de Pendências): dois eventos de
  desfecho (alta/óbito/transferência) diferentes para o mesmo paciente,
  ausência além da tolerância do convênio sem retorno documentado, ou um dia
  faturável sem nenhum valor de diária vigente cadastrado para aquela data.

Por design (igual ao escopo original), só os dias **BLOQUEADO** entram na
fila de Resolução de Pendências com o fluxo de justificativa obrigatória. Um
dia em REVISÃO RECOMENDADA fica visível na memória de cálculo do paciente
(e zera o valor daquele dia específico) mas não gera uma pendência formal —
o caminho para corrigi-lo é reenviar um censo mais completo e reprocessar,
não editar manualmente ali.

### Limitações conhecidas (leia antes de confiar 100% no resultado)

- O parser lê texto livre em português escrito por pessoas diferentes ao
  longo do mês — variações de grafia não previstas podem não ser reconhecidas
  e cair em REVISÃO RECOMENDADA (comportamento seguro: nunca inventa uma data
  para não gerar um valor errado silenciosamente).
- A regra "ausência conta a última diária" (cadastrada em Configuração de
  Convênios) hoje não é usada pelo motor de cálculo — a regra que está
  implementada é a de tolerância em horas. Se isso for necessário, é um bom
  próximo ajuste no `billing-engine.js`.
- Este código não pôde ser testado ponta a ponta neste ambiente (sem Node
  disponível para rodar um servidor local, e sem um projeto Supabase real
  ainda criado) — foi revisado linha a linha contra a estrutura real do
  arquivo de censo, mas vale rodar um processamento de teste com um mês real
  e conferir a memória de cálculo de 2 ou 3 pacientes manualmente antes de
  usar para faturar de verdade.
- "Calcular período automaticamente" continua propositalmente desativado na
  tela de Seleção — é o espaço reservado para essa função futura, como pedido
  no escopo original.
