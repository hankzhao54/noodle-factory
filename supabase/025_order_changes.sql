-- =====================================================================
-- 025 · 修改 / 部分取消 / 拆分订单
--   edit_order_lines(order, [{line_id, qty}])  staff: change quantities; qty 0 = cancel that product.
--                                              Nothing left → the whole order is cancelled.
--   split_order(order, [line ids], date)       staff: move some products to a new order (another day).
--   cancel_my_order_line(line)                 customer: cancel one product while the order still waits for confirmation.
--   Not possible once the order is delivered or cancelled. Every change is in the activity log,
--   and a short note goes to Slack (event 'changed').
-- =====================================================================

alter table noodle.orders add column if not exists split_from uuid references noodle.orders(id) on delete set null;

-- new orders created by a split are not "new orders" for emails / Slack
create or replace function noodle.queue_order_email() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_event text; v_secret text;
begin
  if tg_op = 'INSERT' then
    if new.split_from is not null then return new; end if;
    v_event := 'placed';
  elsif old.status = 'submitted' and new.status = 'confirmed' then v_event := 'confirmed';
  elsif old.status is distinct from 'cancelled' and new.status = 'cancelled' then v_event := 'cancelled';
  else return new;
  end if;
  if coalesce((select value from noodle.settings where key = 'email_mode'), 'off') = 'off'
     and coalesce((select value from noodle.settings where key = 'slack_mode'), 'off') = 'off' then return new; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('order_id', new.id, 'event', v_event),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  raise warning 'noodle notification queue failed: %', sqlerrm;
  return new;
end $$;

-- Slack note about a change (no emails)
create or replace function noodle.notify_order_change(p_order uuid, p_detail text) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_secret text;
begin
  if coalesce((select value from noodle.settings where key = 'slack_mode'), 'off') = 'off' then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('order_id', p_order, 'event', 'changed', 'detail', p_detail),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'noodle change notification failed: %', sqlerrm;
end $$;

create or replace function noodle.edit_order_lines(p_order uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; c jsonb; l noodle.order_lines; v_qty numeric; v_note text[] := '{}'; v_name text;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'order can no longer be changed'; end if;
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
    update noodle.orders set status = 'cancelled' where id = p_order;     -- sends the normal cancellation
    return jsonb_build_object('changed', true, 'cancelled', true);
  end if;
  perform noodle.notify_order_change(p_order, array_to_string(v_note, E'\n'));
  return jsonb_build_object('changed', true, 'cancelled', false);
end $$;

create or replace function noodle.split_order(p_order uuid, p_lines uuid[], p_delivery_date date) returns uuid
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; v_new uuid; v_names text;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'order can no longer be changed'; end if;
  if p_delivery_date is null or p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if coalesce(cardinality(p_lines), 0) = 0 then raise exception 'nothing to split'; end if;
  if (select count(*) from noodle.order_lines where order_id = p_order and id = any (p_lines)) <> cardinality(p_lines) then
    raise exception 'line not in order';
  end if;
  if not exists (select 1 from noodle.order_lines where order_id = p_order and not (id = any (p_lines))) then
    raise exception 'keep at least one product';
  end if;
  insert into noodle.orders (customer_id, location_id, delivery_date, notes, status, split_from)
  values (o.customer_id, o.location_id, p_delivery_date, o.notes, case when o.status = 'submitted' then 'submitted' else 'confirmed' end, o.id)
  returning id into v_new;
  update noodle.order_lines set order_id = v_new where order_id = p_order and id = any (p_lines);
  select string_agg(p.name_hu || ' ' || trim_scale(l.qty), ', ') into v_names
    from noodle.order_lines l join noodle.products p on p.id = l.product_id where l.order_id = v_new;
  perform noodle.notify_order_change(p_order, format('%s → #%s (%s)', v_names, (select no from noodle.orders where id = v_new), to_char(p_delivery_date, 'YYYY-MM-DD')));
  return v_new;
end $$;

create or replace function noodle.cancel_my_order_line(p_line uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare l noodle.order_lines; o noodle.orders; v_name text;
begin
  select * into l from noodle.order_lines where id = p_line;
  select * into o from noodle.orders where id = l.order_id for update;
  if o.id is null or o.customer_id is distinct from noodle.my_customer_id()
     or (noodle.my_location_id() is not null and o.location_id is distinct from noodle.my_location_id()) then
    raise exception 'not allowed';
  end if;
  if o.status <> 'submitted' then raise exception 'order can no longer be cancelled'; end if;
  select name_hu into v_name from noodle.products where id = l.product_id;
  delete from noodle.order_lines where id = l.id;
  if not exists (select 1 from noodle.order_lines where order_id = o.id) then
    update noodle.orders set status = 'cancelled' where id = o.id;
  else
    perform noodle.notify_order_change(o.id, format('%s: %s → ✕ (customer)', v_name, trim_scale(l.qty)));
  end if;
end $$;

revoke execute on function noodle.notify_order_change(uuid, text) from public, anon, authenticated;
revoke execute on function noodle.edit_order_lines(uuid, jsonb) from public, anon;
revoke execute on function noodle.split_order(uuid, uuid[], date) from public, anon;
revoke execute on function noodle.cancel_my_order_line(uuid) from public, anon;
grant execute on function noodle.edit_order_lines(uuid, jsonb) to authenticated;
grant execute on function noodle.split_order(uuid, uuid[], date) to authenticated;
grant execute on function noodle.cancel_my_order_line(uuid) to authenticated;
notify pgrst, 'reload schema';
