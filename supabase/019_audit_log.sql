-- =====================================================================
-- 019 · 操作记录（audit log）+ 前端错误记录
--   A trigger on every business table writes who changed what and when (insert / update / delete,
--   with old → new values). Changes made through RPCs (place_order, complete_production …) are
--   recorded under the signed-in user too. Errors shown to users are logged by the app (log_client_error).
--   Only admins can read the log; nobody can edit or delete it through the API.
-- =====================================================================

create table if not exists noodle.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  user_email  text,
  action      text not null,          -- insert | update | delete | error
  table_name  text,
  row_id      text,
  label       text,                   -- human-readable: order no, name, code, setting key …
  changes     jsonb,                  -- update: {"col": [old, new]}; insert/delete: the row; error: {message, path, …}
  origin      text                    -- 'app' (signed-in user) | 'system' (service / SQL / trigger without a user)
);
create index if not exists audit_log_at on noodle.audit_log (at desc);
create index if not exists audit_log_table on noodle.audit_log (table_name, at desc);
create index if not exists audit_log_user on noodle.audit_log (user_id, at desc);

alter table noodle.audit_log enable row level security;
drop policy if exists admin_read on noodle.audit_log;
create policy admin_read on noodle.audit_log for select to authenticated using (noodle.is_admin());
revoke all on noodle.audit_log from anon, authenticated;
grant select on noodle.audit_log to authenticated;

create or replace function noodle.audit_trigger() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb;
  v_uid uuid := auth.uid();
  v_label text;
  v_id text;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_array(v_old -> k, v_new -> k)) into v_changes
    from jsonb_object_keys(v_new) k
    where k not in ('updated_at') and (v_old -> k) is distinct from (v_new -> k);
    if v_changes is null then return null; end if;     -- nothing really changed
  else
    v_changes := v_row - 'updated_at';
  end if;

  v_id := coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'key',
                   nullif(concat_ws('/', v_row ->> 'customer_id', v_row ->> 'tier_id', v_row ->> 'product_id'), ''));
  v_label := coalesce(
    case when v_row ? 'no' and tg_table_name in ('orders', 'deliveries', 'purchase_orders', 'production_batches') then '#' || (v_row ->> 'no') end,
    v_row ->> 'name', v_row ->> 'name_hu', v_row ->> 'display_name', v_row ->> 'key', v_row ->> 'code', v_row ->> 'lot_no');
  -- lines: point at their order / product
  if tg_table_name = 'order_lines' then
    v_label := (select '#' || o.no from noodle.orders o where o.id = (v_row ->> 'order_id')::uuid);
  elsif tg_table_name in ('customer_prices', 'price_tier_prices', 'recipe_lines') then
    v_label := concat_ws(' · ',
      (select name from noodle.customers where id = (v_row ->> 'customer_id')::uuid),
      (select name from noodle.price_tiers where id = (v_row ->> 'tier_id')::uuid),
      (select name_hu from noodle.products where id = (v_row ->> 'product_id')::uuid),
      (select name_hu from noodle.materials where id = (v_row ->> 'material_id')::uuid));
  elsif tg_table_name = 'stock_movements' then
    v_label := concat_ws(' · ',
      coalesce((select name_hu from noodle.materials where id = (v_row ->> 'material_id')::uuid),
               (select name_hu from noodle.products where id = (v_row ->> 'product_id')::uuid)),
      v_row ->> 'reason', v_row ->> 'qty');
  end if;

  insert into noodle.audit_log(user_id, user_email, action, table_name, row_id, label, changes, origin)
  values (v_uid, (select email from auth.users where id = v_uid), lower(tg_op), tg_table_name, v_id, left(v_label, 200),
          v_changes, case when v_uid is null then 'system' else 'app' end);
  return null;
exception when others then
  raise warning 'audit failed: %', sqlerrm;   -- never block the real change
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['orders','order_lines','customers','customer_prices','price_tiers','price_tier_prices',
                           'products','recipe_lines','materials','suppliers','purchase_orders','purchase_order_lines',
                           'production_batches','stock_movements','deliveries','profiles','settings'] loop
    execute format('drop trigger if exists audit on noodle.%I', t);
    execute format('create trigger audit after insert or update or delete on noodle.%I
                    for each row execute function noodle.audit_trigger()', t);
  end loop;
end $$;

-- errors the app showed to a signed-in user (failed save, failed order …)
create or replace function noodle.log_client_error(p_message text, p_path text default null, p_context jsonb default null)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  -- at most 30 error rows per user per 10 minutes (protects against loops / spam)
  if (select count(*) from noodle.audit_log where user_id = v_uid and action = 'error' and at > now() - interval '10 minutes') >= 30 then
    return;
  end if;
  insert into noodle.audit_log(user_id, user_email, action, table_name, label, changes, origin)
  values (v_uid, (select email from auth.users where id = v_uid), 'error', null, left(p_path, 200),
          jsonb_build_object('message', left(p_message, 1000), 'path', left(p_path, 200))
            || coalesce(case when pg_column_size(p_context) < 4000 then p_context end, '{}'::jsonb),
          'app');
end $$;

revoke execute on function noodle.audit_trigger() from public, anon, authenticated;
revoke execute on function noodle.log_client_error(text, text, jsonb) from public, anon;
grant execute on function noodle.log_client_error(text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
