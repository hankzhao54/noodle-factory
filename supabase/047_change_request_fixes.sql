-- =====================================================================
-- 047 · 自查修复
--   1. Order cancelled / delivered while a change request is open → the request is closed
--      automatically (it could no longer be approved and stayed on the dashboard as a todo).
--   2. Approving a request whose product line was removed from the order in the meantime no
--      longer fails with "line not in order"; that line is skipped.
--   3. Fixed search_path on four pure helper functions (security advisor).
-- =====================================================================
create or replace function noodle.close_change_requests_on_order_end() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if new.status in ('cancelled', 'delivered') and old.status is distinct from new.status then
    update noodle.order_change_requests
       set status = 'withdrawn', decided_at = now(),
           decision_note = coalesce(decision_note, 'order ' || new.status)
     where order_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
revoke execute on function noodle.close_change_requests_on_order_end() from public, anon, authenticated;
drop trigger if exists close_change_requests on noodle.orders;
create trigger close_change_requests after update of status on noodle.orders
  for each row execute function noodle.close_change_requests_on_order_end();

-- requests already stuck on closed orders
update noodle.order_change_requests r set status = 'withdrawn', decided_at = now(), decision_note = 'order ' || o.status
  from noodle.orders o where o.id = r.order_id and r.status = 'pending' and o.status in ('cancelled', 'delivered');

create or replace function noodle.decide_change_request(p_request uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = noodle, pg_temp as $$
declare r noodle.order_change_requests; o noodle.orders; a jsonb; v_line uuid; v_res jsonb := '{}'; v_lines jsonb;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into r from noodle.order_change_requests where id = p_request for update;
  if r.id is null or r.status <> 'pending' then raise exception 'request already decided'; end if;
  select * into o from noodle.orders where id = r.order_id for update;

  if not p_approve then
    update noodle.order_change_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(p_note, '') where id = r.id;
    perform noodle.notify_order_change(o.id, '❌ Change request rejected' || coalesce(': ' || nullif(p_note, ''), ''));
    return jsonb_build_object('approved', false);
  end if;
  if o.status not in ('submitted', 'confirmed', 'ready') then raise exception 'order can no longer be changed'; end if;

  -- only lines still in the order (staff may have edited it since)
  select coalesce(jsonb_agg(c), '[]') into v_lines
    from jsonb_array_elements(r.lines) c
   where exists (select 1 from noodle.order_lines l where l.id = (c->>'line_id')::uuid and l.order_id = o.id);

  -- extra products first (an existing product gets the quantity added), then the new quantities
  for a in select * from jsonb_array_elements(r.additions) loop
    select id into v_line from noodle.order_lines where order_id = o.id and product_id = (a->>'product_id')::uuid limit 1;
    if v_line is not null then
      update noodle.order_lines set qty = qty + (a->>'qty')::numeric where id = v_line;
    else
      insert into noodle.order_lines (order_id, product_id, qty, unit_price)
      values (o.id, (a->>'product_id')::uuid, (a->>'qty')::numeric, noodle.price_for(o.customer_id, (a->>'product_id')::uuid));
    end if;
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    v_res := noodle.apply_order_line_changes(o.id, v_lines, 'approved request');
  end if;
  if r.delivery_date is not null and r.delivery_date <> o.delivery_date and not coalesce((v_res->>'cancelled')::boolean, false) then
    update noodle.orders set delivery_date = r.delivery_date, delivery_id = null where id = o.id;
  end if;
  update noodle.order_change_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(p_note, '') where id = r.id;
  if not coalesce((v_res->>'cancelled')::boolean, false)
     and (jsonb_array_length(r.additions) > 0 or r.delivery_date is not null or not coalesce((v_res->>'changed')::boolean, false)) then
    perform noodle.notify_order_change(o.id, '✅ Change request approved:' || E'\n' || noodle.change_request_text(r));
  end if;
  return jsonb_build_object('approved', true, 'cancelled', coalesce((v_res->>'cancelled')::boolean, false));
end $$;
revoke execute on function noodle.decide_change_request(uuid, boolean, text) from public, anon;
grant execute on function noodle.decide_change_request(uuid, boolean, text) to authenticated;

alter function noodle.client_ip() set search_path = noodle, pg_temp;
alter function noodle.distance_m(double precision, double precision, double precision, double precision) set search_path = noodle, pg_temp;
alter function noodle.easter_sunday(integer) set search_path = noodle, pg_temp;
alter function noodle.hu_holidays(integer) set search_path = noodle, pg_temp;
notify pgrst, 'reload schema';
