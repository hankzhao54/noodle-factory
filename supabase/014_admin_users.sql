-- =====================================================================
-- 014 · 管理员直接添加 / 删除账号（配合 Edge Function noodle-admin-users）
--   The login accounts (auth.users) are shared with order-app (schema ordering) and the
--   recipes app (public.profiles). Deleting is therefore only "full" when the user is used
--   by nobody else; otherwise only the noodle access (noodle.profiles) is removed.
--   These helpers are for the edge function (service_role) only.
-- =====================================================================

-- which other apps reference this login (by schema), e.g. {ordering, public}
create or replace function noodle.user_other_apps(p_user uuid) returns text[]
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare r record; v_found boolean; v_out text[] := '{}';
begin
  for r in
    select n.nspname as sch, cl.relname as tbl, a.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
      and n.nspname not in ('auth', 'noodle', 'storage', 'realtime', 'vault', 'extensions')
  loop
    continue when r.sch = any (v_out);
    execute format('select exists (select 1 from %I.%I where %I = $1)', r.sch, r.tbl, r.col) into v_found using p_user;
    if v_found then v_out := v_out || r.sch; end if;
  end loop;
  return v_out;
end $$;

create or replace function noodle.user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = noodle, pg_temp as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1
$$;

revoke execute on function noodle.user_other_apps(uuid) from public, anon, authenticated;
revoke execute on function noodle.user_id_by_email(text) from public, anon, authenticated;
grant execute on function noodle.user_other_apps(uuid) to service_role;
grant execute on function noodle.user_id_by_email(text) to service_role;
grant select, insert, update, delete on noodle.profiles to service_role;
grant usage on schema noodle to service_role;

notify pgrst, 'reload schema';
