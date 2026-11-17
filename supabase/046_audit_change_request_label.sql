-- =====================================================================
-- 046 · 操作日志：改单申请显示订单号（#20）
-- =====================================================================
create or replace function noodle.audit_trigger()
returns trigger language plpgsql security definer set search_path = noodle, pg_temp as $function$
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
    if v_changes is null then return null; end if;
  else
    v_changes := v_row - 'updated_at';
  end if;

  v_id := coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'key',
                   nullif(concat_ws('/', v_row ->> 'customer_id', v_row ->> 'tier_id', v_row ->> 'product_id'), ''));
  v_label := coalesce(
    case when v_row ? 'no' and tg_table_name in ('orders', 'deliveries', 'purchase_orders', 'production_batches') then '#' || (v_row ->> 'no') end,
    v_row ->> 'name', v_row ->> 'name_hu', v_row ->> 'display_name', v_row ->> 'key', v_row ->> 'code', v_row ->> 'lot_no');
  if tg_table_name in ('order_lines', 'order_change_requests') then
    v_label := (select '#' || o.no from noodle.orders o where o.id = (v_row ->> 'order_id')::uuid)
               || case when tg_table_name = 'order_change_requests' then ' · ' || (v_row ->> 'status') else '' end;
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
  raise warning 'audit failed: %', sqlerrm;
  return null;
end $function$;

-- label the rows already logged
update noodle.audit_log a set label = '#' || o.no || ' · ' || coalesce(r.status, a.changes ->> 'status', '')
  from noodle.order_change_requests r join noodle.orders o on o.id = r.order_id
 where a.table_name = 'order_change_requests' and a.label is null and a.row_id = r.id::text;
