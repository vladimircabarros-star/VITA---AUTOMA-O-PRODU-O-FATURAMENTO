# VITA — Automação de Produção/Faturamento

Sistema interno de apuração de faturamento hospitalar por convênio (censo →
processamento → pendências → exportação), do VITA Centro de Cuidados
Extensivos (Natal/RN).

## Estrutura do repositório

- **[`vita-app/`](vita-app/)** — o aplicativo web (HTML/CSS/JS puro, sem
  build). Login, upload e leitura do censo (.xlsx), motor de cálculo do
  faturamento, resolução de pendências, configuração de convênios, histórico
  e exportação (Excel/PDF) — tudo conectado a um projeto Supabase real.
  Veja [`vita-app/README.md`](vita-app/README.md) para configurar e rodar.
- **[`supabase/`](supabase/)** — migrations SQL do backend (schema, Row Level
  Security, storage) para o projeto Supabase. Veja
  [`supabase/README.md`](supabase/README.md).

## Como rodar

1. Crie um projeto no [Supabase](https://supabase.com) e aplique as
   migrations em `supabase/migrations/` (nessa ordem).
2. Preencha `vita-app/config.js` com a URL e a anon key do projeto.
3. Sirva a pasta `vita-app/` com qualquer servidor estático
   (`npx serve vita-app`, `python -m http.server` dentro da pasta, ou
   publique em Netlify/Vercel/GitHub Pages).

Detalhes completos, incluindo como o motor de cálculo interpreta o arquivo
de censo (cores de evento, regras por convênio) e limitações conhecidas,
estão em [`vita-app/README.md`](vita-app/README.md).
