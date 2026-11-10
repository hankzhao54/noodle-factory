-- =====================================================================
-- 026 · 自家餐厅在排生产之前可以改单
--   Own restaurants (role 'restaurant') may change quantities, cancel products or cancel the whole
--   order while it is waiting / confirmed — until production has been planned for it:
--   a product is locked once a production batch for it was planned after the order was placed,
--   for a production day up to the delivery date. External customers: unchanged (only while waiting).
-- =====================================================================

create or replace function noodle.order_line_locked(p_line uuid) returns boolean
language sql stable security definer set search_path = noodle, pg_temp as $$
  select exists (
    select 1 from noodle.order_lines l
    join noodle.orders o on o.id = l.order_id
    join noodle.production_batches b on b.product_id = l.product_id
    where l.id = p_line and b.status in ('planned', 'done')
      and b.created_at >= o.created_at and b.planned_date <= o.delivery_date)
$$;

-- shared by staff edits and own-restaurant edits
create or replace function noodle.apply_order_line_changes(p_order uuid, p_changes jsonb, p_who text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare c jsonb; l noodle.order_lines; v_qty numeric; v_note text[] := '{}'; v_name text;
begin
  for c in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    select * into l from noodle.order_lines where id = (c ->> 'line_id')::uuid and order_id = p_order;
    if l.id is null then raise exception 'line not in order'; end if;
    v_qty := coalesce((c ->> 'qty')::numeric, 0);
    continue when v_qty = l.qty;
    select name_hu into v_name from noodle.products where id = l.product_id;
    if v_qty <= 0 then
      delete from noodle.order_lines where id = l.id;
      v_note := v_note || format('%s: %s → ✕', v_name, trim_scale(l.qty));
    else
      update noodle.order_lines set qty = v_qty where id = l.id;
      v_note := v_note || format('%s: %s → %s', v_name, trim_scale(l.qty), trim_scale(v_qty));
    end if;
  end loop;
  if cardinality(v_note) = 0 then return jsonb_build_object('changed', false); end if;
  if not exists (select 1 from noodle.order_lines where order_id = p_order) then
    update noodle.orders set status = 'cancelled' where id = p_order;
    return jsonb_build_object('changed', true, 'cancelled', true);
  end if;
  perform noodle.notify_order_change(p_order, array_to_string(v_note, E'\n') || coalesce(E'\n(' || p_who || ')', ''));
  return jsonb_build_object('changed', true, 'cancelled', false);
end $$;

create or replace function noodle.edit_order_lines(p_order uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'order can no longer be changed'; end if;
  return noodle.apply_order_line_changes(p_order, p_changes, null);
end $$;

-- is the signed-in account allowed to change this order (and which products are locked)?
create or replace function noodle.my_order_can_change(p_order uuid) returns boolean
language sql stable security definer set search_path = noodle, pg_temp as $$
  select exists (
    select 1 from noodle.orders o
    where o.id = p_order and o.customer_id = noodle.my_customer_id()
      and (noodle.my_location_id() is null or o.location_id = noodle.my_location_id())
      and (o.status = 'submitted' or (o.status = 'confirmed' and noodle.my_role() = 'restaurant')))
$$;

-- for the portal: orders this account can still change, with the products that are locked
create or replace function noodle.my_order_edit_info() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce(jsonb_object_agg(o.id, jsonb_build_object(
           'locked', coalesce((select jsonb_agg(l.id) from noodle.order_lines l
                                where l.order_id = o.id and noodle.my_role() = 'restaurant' and noodle.order_line_locked(l.id)), '[]'::jsonb))), '{}'::jsonb)
  from noodle.orders o
  where o.customer_id = noodle.my_customer_id() and o.delivery_date >= current_date and noodle.my_order_can_change(o.id)
$$;

create or replace function noodle.edit_my_order(p_order uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare c jsonb;
begin
  perform 1 from noodle.orders where id = p_order for update;
  if not noodle.my_order_can_change(p_order) then raise exception 'order can no longer be changed'; end if;
  if noodle.my_role() = 'customer' then
    -- external customers: only cancelling products (quantities are agreed), and only while waiting
    for c in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
      if coalesce((c ->> 'qty')::numeric, 0) > 0 then raise exception 'not allowed'; end if;
    end loop;
  else
    for c in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
      if noodle.order_line_locked((c ->> 'line_id')::uuid) then raise exception 'production planned'; end if;
    end loop;
  end if;
  return noodle.apply_order_line_changes(p_order, p_changes,
    (select coalesce(display_name, 'customer') from noodle.profiles where user_id = auth.uid()));
end $$;

-- cancel the whole order: customers while waiting; own restaurants also when confirmed, if nothing is planned yet
create or replace function noodle.cancel_my_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if noodle.is_staff() then
    update noodle.orders set status = 'cancelled' where id = p_order_id and status in ('submitted', 'confirmed', 'ready');
  else
    if not noodle.my_order_can_change(p_order_id)
       or exists (select 1 from noodle.order_lines l where l.order_id = p_order_id
                   and noodle.my_role() = 'restaurant' and noodle.order_line_locked(l.id)) then
      raise exception 'order can no longer be cancelled';
    end if;
    update noodle.orders set status = 'cancelled' where id = p_order_id;
  end if;
  if not found then raise exception 'order can no longer be cancelled'; end if;
end $$;

-- single product (kept for older app versions): same rules as edit_my_order
create or replace function noodle.cancel_my_order_line(p_line uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_order uuid;
begin
  select order_id into v_order from noodle.order_lines where id = p_line;
  if v_order is null then raise exception 'not allowed'; end if;
  perform noodle.edit_my_order(v_order, jsonb_build_array(jsonb_build_object('line_id', p_line, 'qty', 0)));
end $$;

revoke execute on function noodle.apply_order_line_changes(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function noodle.order_line_locked(uuid) from public, anon, authenticated;
revoke execute on function noodle.my_order_can_change(uuid) from public, anon, authenticated;
revoke execute on function noodle.my_order_edit_info() from public, anon;
revoke execute on function noodle.edit_my_order(uuid, jsonb) from public, anon;
revoke execute on function noodle.edit_order_lines(uuid, jsonb) from public, anon;
revoke execute on function noodle.cancel_my_order(uuid) from public, anon;
revoke execute on function noodle.cancel_my_order_line(uuid) from public, anon;
grant execute on function noodle.my_order_edit_info() to authenticated;
grant execute on function noodle.edit_my_order(uuid, jsonb) to authenticated;
grant execute on function noodle.edit_order_lines(uuid, jsonb) to authenticated;
grant execute on function noodle.cancel_my_order(uuid) to authenticated;
grant execute on function noodle.cancel_my_order_line(uuid) to authenticated;
notify pgrst, 'reload schema';
