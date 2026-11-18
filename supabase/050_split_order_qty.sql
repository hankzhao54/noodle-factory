-- =====================================================================
-- 050 · 送货页拆单补送：货不够时，把一部分数量拆成一张新订单，改到后面的日子送
--   split_order_qty(order, [{line_id, qty}], date): qty = how much of that line is delivered later.
--   The whole line moves when qty ≥ the ordered quantity; otherwise the line is reduced and the rest
--   goes to the new order at the same price. Something must stay on the original order.
--   The new order keeps customer, store and notes (split_from = original), no new-order e-mail;
--   Slack gets "order changed" on the original.
-- =====================================================================
create or replace function noodle.split_order_qty(p_order uuid, p_items jsonb, p_delivery_date date)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; v_new uuid; c jsonb; l noodle.order_lines; v_later numeric; v_names text; v_any boolean := false;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'order can no longer be changed'; end if;
  if p_delivery_date is null or p_delivery_date < (now() at time zone 'Europe/Budapest')::date then raise exception 'delivery date in the past'; end if;

  insert into noodle.orders (customer_id, location_id, delivery_date, notes, status, split_from)
  values (o.customer_id, o.location_id, p_delivery_date, o.notes, case when o.status = 'submitted' then 'submitted' else 'confirmed' end, o.id)
  returning id into v_new;

  for c in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_later := coalesce((c->>'qty')::numeric, 0);
    continue when v_later <= 0;
    select * into l from noodle.order_lines where id = (c->>'line_id')::uuid and order_id = o.id for update;
    if l.id is null then raise exception 'line not in order'; end if;
    v_any := true;
    if v_later >= l.qty then
      update noodle.order_lines set order_id = v_new where id = l.id;
    else
      update noodle.order_lines set qty = qty - v_later where id = l.id;
      insert into noodle.order_lines (order_id, product_id, qty, unit_price) values (v_new, l.product_id, v_later, l.unit_price);
    end if;
  end loop;
  if not v_any then raise exception 'nothing to split'; end if;
  if not exists (select 1 from noodle.order_lines where order_id = o.id) then raise exception 'keep at least one product'; end if;

  select string_agg(p.name_hu || ' ' || trim_scale(x.qty), ', ') into v_names
    from noodle.order_lines x join noodle.products p on p.id = x.product_id where x.order_id = v_new;
  perform noodle.notify_order_change(o.id, format('✂️ %s → #%s (%s)', v_names, (select no from noodle.orders where id = v_new), to_char(p_delivery_date, 'YYYY-MM-DD')));
  return v_new;
end $$;
revoke execute on function noodle.split_order_qty(uuid, jsonb, date) from public, anon;
grant execute on function noodle.split_order_qty(uuid, jsonb, date) to authenticated;
notify pgrst, 'reload schema';
