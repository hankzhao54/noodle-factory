-- =====================================================================
-- 029 · 自家餐厅收货后一键确认（不用送货单）
--   confirm_my_receipt(order): an own-restaurant account confirms that its order arrived.
--   Same effect as staff "delivered": quantities as ordered, stock goes out, the run is closed
--   when it was the last stop. received_by = the account's name. Only on/after the delivery day.
--   deliver_order (staff) and confirm_my_receipt share do_deliver_order.
-- =====================================================================

create or replace function noodle.do_deliver_order(p_order_id uuid, p_lines jsonb, p_received_by text, p_proofs text[])
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; l noodle.order_lines; v_qty numeric; v_given jsonb;
begin
  select * into o from noodle.orders where id = p_order_id for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status not in ('submitted','confirmed','ready') then raise exception 'order already delivered or cancelled'; end if;

  for l in select * from noodle.order_lines where order_id = o.id loop
    select x into v_given from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) x
      where x->>'line_id' = l.id::text limit 1;
    v_qty := coalesce((v_given->>'qty')::numeric, l.qty);
    if v_qty < 0 then raise exception 'invalid quantity'; end if;
    update noodle.order_lines set delivered_qty = v_qty where id = l.id;
    if v_qty > 0 then
      insert into noodle.stock_movements(product_id, qty, reason, ref_id, note)
      values (l.product_id, -v_qty, 'delivery', o.id, 'order #' || o.no);
    end if;
  end loop;

  update noodle.orders
     set status = 'delivered', delivered_at = now(), delivered_by = auth.uid(),
         received_by = nullif(p_received_by, ''),
         proof_paths = coalesce(p_proofs, '{}')
   where id = o.id;

  if o.delivery_id is not null and not exists (
       select 1 from noodle.orders where delivery_id = o.delivery_id
       and status in ('submitted','confirmed','ready')) then
    update noodle.deliveries set status = 'done', done_at = now() where id = o.delivery_id;
  end if;
end $$;

create or replace function noodle.deliver_order(p_order_id uuid, p_lines jsonb default '[]',
  p_received_by text default null, p_proofs text[] default '{}')
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  perform noodle.do_deliver_order(p_order_id, p_lines, p_received_by, p_proofs);
end $$;

create or replace function noodle.confirm_my_receipt(p_order uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders;
begin
  if noodle.my_role() <> 'restaurant' then raise exception 'not allowed'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from noodle.my_customer_id()
     or (noodle.my_location_id() is not null and o.location_id is distinct from noodle.my_location_id()) then
    raise exception 'not allowed';
  end if;
  if o.status not in ('submitted','confirmed','ready') then raise exception 'order already delivered or cancelled'; end if;
  if o.delivery_date > (now() at time zone 'Europe/Budapest')::date then raise exception 'not delivery day yet'; end if;
  perform noodle.do_deliver_order(p_order, '[]'::jsonb,
    (select coalesce(nullif(display_name, ''), 'restaurant') from noodle.profiles where user_id = auth.uid()), '{}');
end $$;

revoke execute on function noodle.do_deliver_order(uuid, jsonb, text, text[]) from public, anon, authenticated;
revoke execute on function noodle.deliver_order(uuid, jsonb, text, text[]) from public, anon;
revoke execute on function noodle.confirm_my_receipt(uuid) from public, anon;
grant execute on function noodle.deliver_order(uuid, jsonb, text, text[]) to authenticated;
grant execute on function noodle.confirm_my_receipt(uuid) to authenticated;
notify pgrst, 'reload schema';
