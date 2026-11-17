-- =====================================================================
-- 045 · 改单申请：确认之后也能申请修改，工厂确认后才生效
--   Customers / own restaurants send a request (new quantities, extra products, another delivery
--   day, a note) for an order that is confirmed or ready — the cases they can no longer change
--   themselves. The factory approves (changes are applied) or rejects (with a reason).
--   One open request per order; a new one replaces it. Every step goes to Slack ('changed').
-- =====================================================================
create table if not exists noodle.order_change_requests (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references noodle.orders(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  lines         jsonb not null default '[]',   -- [{line_id, qty}] new quantity of an existing product (0 = remove)
  additions     jsonb not null default '[]',   -- [{product_id, qty}] products to add
  delivery_date date,                          -- new delivery day, or null
  note          text,
  requested_by  uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text
);
create index if not exists order_change_requests_order on noodle.order_change_requests(order_id, created_at desc);
create unique index if not exists order_change_requests_one_pending on noodle.order_change_requests(order_id) where status = 'pending';

alter table noodle.order_change_requests enable row level security;
drop policy if exists staff_all on noodle.order_change_requests;
drop policy if exists cust_read on noodle.order_change_requests;
create policy staff_all on noodle.order_change_requests for all to authenticated using (noodle.is_staff()) with check (noodle.is_staff());
create policy cust_read on noodle.order_change_requests for select to authenticated using (exists (
  select 1 from noodle.orders o where o.id = order_id and o.customer_id = noodle.my_customer_id()
    and (noodle.my_location_id() is null or o.location_id = noodle.my_location_id())));
grant select on noodle.order_change_requests to authenticated;

drop trigger if exists audit on noodle.order_change_requests;
create trigger audit after insert or update or delete on noodle.order_change_requests
  for each row execute function noodle.audit_trigger();

-- readable summary for Slack / the activity log
create or replace function noodle.change_request_text(r noodle.order_change_requests) returns text
language sql stable security definer set search_path = noodle, pg_temp as $$
  select concat_ws(E'\n',
    (select string_agg(format('%s: %s → %s', p.name_hu, trim_scale(l.qty), case when (c->>'qty')::numeric > 0 then trim_scale((c->>'qty')::numeric)::text else '✕' end), E'\n')
       from jsonb_array_elements(r.lines) c join noodle.order_lines l on l.id = (c->>'line_id')::uuid join noodle.products p on p.id = l.product_id),
    (select string_agg(format('+ %s %s', p.name_hu, trim_scale((a->>'qty')::numeric)), E'\n')
       from jsonb_array_elements(r.additions) a join noodle.products p on p.id = (a->>'product_id')::uuid),
    case when r.delivery_date is not null then format('📅 → %s', to_char(r.delivery_date, 'YYYY-MM-DD')) end,
    case when nullif(r.note, '') is not null then '“' || r.note || '”' end)
$$;

create or replace function noodle.request_order_change(p_order uuid, p_lines jsonb, p_additions jsonb, p_date date, p_note text)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; c jsonb; v_id uuid; r noodle.order_change_requests; v_lines jsonb := '[]'; v_add jsonb := '[]';
begin
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from noodle.my_customer_id()
     or (noodle.my_location_id() is not null and o.location_id is distinct from noodle.my_location_id()) then
    raise exception 'not allowed';
  end if;
  if o.status not in ('submitted', 'confirmed', 'ready') then raise exception 'order can no longer be changed'; end if;
  -- keep only real changes
  for c in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    if not exists (select 1 from noodle.order_lines where id = (c->>'line_id')::uuid and order_id = o.id) then raise exception 'line not in order'; end if;
    if coalesce((c->>'qty')::numeric, 0) < 0 then raise exception 'invalid quantity'; end if;
    if (select qty from noodle.order_lines where id = (c->>'line_id')::uuid) <> coalesce((c->>'qty')::numeric, 0) then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_id', c->>'line_id', 'qty', coalesce((c->>'qty')::numeric, 0)));
    end if;
  end loop;
  for c in select * from jsonb_array_elements(coalesce(p_additions, '[]')) loop
    continue when coalesce((c->>'qty')::numeric, 0) <= 0;
    if not exists (select 1 from noodle.products where id = (c->>'product_id')::uuid and active and visible_to_customers) then
      raise exception 'product not available';
    end if;
    v_add := v_add || jsonb_build_array(jsonb_build_object('product_id', c->>'product_id', 'qty', (c->>'qty')::numeric));
  end loop;
  if p_date is not null and (p_date = o.delivery_date) then p_date := null; end if;
  if p_date is not null and p_date < (now() at time zone 'Europe/Budapest')::date then raise exception 'delivery date in the past'; end if;
  if jsonb_array_length(v_lines) = 0 and jsonb_array_length(v_add) = 0 and p_date is null and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'nothing to change';
  end if;

  update noodle.order_change_requests set status = 'withdrawn', decided_at = now() where order_id = o.id and status = 'pending';
  insert into noodle.order_change_requests (order_id, lines, additions, delivery_date, note)
  values (o.id, v_lines, v_add, p_date, nullif(trim(coalesce(p_note, '')), ''))
  returning * into r;
  perform noodle.notify_order_change(o.id, '✋ Change requested (needs confirmation):' || E'\n' || noodle.change_request_text(r)
    || coalesce(E'\n(' || (select display_name from noodle.profiles where user_id = auth.uid()) || ')', ''));
  return r.id;
end $$;

create or replace function noodle.withdraw_change_request(p_request uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  update noodle.order_change_requests r set status = 'withdrawn', decided_at = now()
   where r.id = p_request and r.status = 'pending'
     and exists (select 1 from noodle.orders o where o.id = r.order_id and o.customer_id = noodle.my_customer_id());
  if not found then raise exception 'not allowed'; end if;
end $$;

create or replace function noodle.decide_change_request(p_request uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = noodle, pg_temp as $$
declare r noodle.order_change_requests; o noodle.orders; a jsonb; v_line uuid; v_res jsonb := '{}'; v_cust uuid;
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
  if jsonb_array_length(r.lines) > 0 then
    v_res := noodle.apply_order_line_changes(o.id, r.lines, 'approved request');
  end if;
  if r.delivery_date is not null and r.delivery_date <> o.delivery_date and not coalesce((v_res->>'cancelled')::boolean, false) then
    update noodle.orders set delivery_date = r.delivery_date, delivery_id = null where id = o.id;
  end if;
  update noodle.order_change_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(p_note, '') where id = r.id;
  -- quantity changes already sent their own note (apply_order_line_changes); add one for the rest
  if not coalesce((v_res->>'cancelled')::boolean, false)
     and (jsonb_array_length(r.additions) > 0 or r.delivery_date is not null or jsonb_array_length(r.lines) = 0) then
    perform noodle.notify_order_change(o.id, '✅ Change request approved:' || E'\n' || noodle.change_request_text(r));
  end if;
  return jsonb_build_object('approved', true, 'cancelled', coalesce((v_res->>'cancelled')::boolean, false));
end $$;

revoke execute on function noodle.change_request_text(noodle.order_change_requests) from public, anon, authenticated;
revoke execute on function noodle.request_order_change(uuid, jsonb, jsonb, date, text) from public, anon;
revoke execute on function noodle.withdraw_change_request(uuid) from public, anon;
revoke execute on function noodle.decide_change_request(uuid, boolean, text) from public, anon;
grant execute on function noodle.request_order_change(uuid, jsonb, jsonb, date, text) to authenticated;
grant execute on function noodle.withdraw_change_request(uuid) to authenticated;
grant execute on function noodle.decide_change_request(uuid, boolean, text) to authenticated;
notify pgrst, 'reload schema';
