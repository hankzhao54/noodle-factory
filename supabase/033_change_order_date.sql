-- =====================================================================
-- 033 · 后台改订单送货日期
--   change_order_date(order, date): staff move a whole open order to another day. It leaves its
--   delivery run (runs belong to a day); a note goes to Slack.
-- =====================================================================
create or replace function noodle.change_order_date(p_order uuid, p_date date) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status not in ('submitted', 'confirmed', 'ready') then raise exception 'order can no longer be changed'; end if;
  if p_date is null or p_date < (now() at time zone 'Europe/Budapest')::date then raise exception 'delivery date in the past'; end if;
  if p_date = o.delivery_date then return; end if;
  update noodle.orders set delivery_date = p_date, delivery_id = null where id = p_order;
  perform noodle.notify_order_change(p_order, format('%s → %s', to_char(o.delivery_date, 'YYYY-MM-DD'), to_char(p_date, 'YYYY-MM-DD')));
end $$;
revoke execute on function noodle.change_order_date(uuid, date) from public, anon;
grant execute on function noodle.change_order_date(uuid, date) to authenticated;
notify pgrst, 'reload schema';
