-- VITA — Automação de Produção/Faturamento
-- Buckets privados para o arquivo de censo enviado e para os relatórios exportados.

insert into storage.buckets (id, name, public)
values ('censos', 'censos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('relatorios', 'relatorios', false)
on conflict (id) do nothing;

create policy "censos_authenticated_all"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'censos')
  with check (bucket_id = 'censos');

create policy "relatorios_authenticated_all"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'relatorios')
  with check (bucket_id = 'relatorios');
