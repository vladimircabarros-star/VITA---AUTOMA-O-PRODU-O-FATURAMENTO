-- Correções apontadas pelo advisor de segurança do Supabase:
-- 1) search_path fixo na função de trigger (evita sequestro de search_path);
-- 2) handle_new_user não pode ser chamada via API pública/RPC — só o trigger
--    de auth.users deve dispará-la;
-- 3) extensão btree_gist movida para fora do schema public.

alter function public.set_atualizado_em() set search_path = public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create schema if not exists extensions;
alter extension btree_gist set schema extensions;
