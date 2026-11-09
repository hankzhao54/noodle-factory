-- =====================================================================
-- 020 · 多门店客户
--   customer = the company (prices, price tier, invoicing); customer_locations = its stores
--   (delivery address, contact, delivery weekdays). A customer with stores must order for one store.
--   Accounts: profiles.location_id null = company account (all stores);
--             set = store account (orders and sees only that store).
-- =====================================================================

create table if not exists noodle.customer_locations (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references noodle.customers(id) on delete cascade,
  name             text not null,
  address          text,
  contact_person   text,
  phone            text,
  delivery_weekdays smallint[],
  notes            text,
  active           boolean not null default true,
  sort             integer not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists customer_locations_customer on noodle.customer_locations (customer_id);

alter table noodle.profiles add column if not exists location_id uuid references noodle.customer_locations(id) on delete set null;
alter table noodle.orders add column if not exists location_id uuid references noodle.customer_locations(id);
create index if not exists orders_location on noodle.orders (location_id);

create or replace function noodle.my_location_id() returns uuid
language sql stable security definer set search_path = noodle, pg_temp as $$
  select location_id from noodle.profiles where user_id = auth.uid() and role in ('customer', 'restaurant')
$$;

-- a store account's store must belong to its company
create or replace function noodle.guard_profile_location() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if new.location_id is not null and not exists (
       select 1 from noodle.customer_locations where id = new.location_id and customer_id = new.customer_id) then
    new.location_id := null;
  end if;
  return new;
end $$;
drop trigger if exists profiles_location_guard on noodle.profiles;
create trigger profiles_location_guard before insert or update of location_id, customer_id on noodle.profiles
  for each row execute function noodle.guard_profile_location();

-- RLS: staff everything; customers their company's stores (store accounts: only their store)
alter table noodle.customer_locations enable row level security;
drop policy if exists staff_all on noodle.customer_locations;
drop policy if exists cust_read on noodle.customer_locations;
create policy staff_all on noodle.customer_locations for all to authenticated using (noodle.is_staff()) with check (noodle.is_staff());
create policy cust_read on noodle.customer_locations for select to authenticated
  using (customer_id = noodle.my_customer_id() and (noodle.my_location_id() is null or id = noodle.my_location_id()));
grant select, insert, update, delete on noodle.customer_locations to authenticated;

-- store accounts only see their store's orders
drop policy if exists cust_orders on noodle.orders;
create policy cust_orders on noodle.orders for select to authenticated
  using (customer_id = noodle.my_customer_id() and (noodle.my_location_id() is null or location_id = noodle.my_location_id()));
drop policy if exists cust_order_lines on noodle.order_lines;
create policy cust_order_lines on noodle.order_lines for select to authenticated
  using (exists (select 1 from noodle.orders o where o.id = order_lines.order_id and o.customer_id = noodle.my_customer_id()
                 and (noodle.my_location_id() is null or o.location_id = noodle.my_location_id())));

create or replace function noodle.cancel_my_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  update noodle.orders set status = 'cancelled'
   where id = p_order_id and status = 'submitted'
     and ((customer_id = noodle.my_customer_id() and (noodle.my_location_id() is null or location_id = noodle.my_location_id()))
          or noodle.is_staff());
  if not found then raise exception 'order can no longer be cancelled'; end if;
end $$;

-- delivery-date check: the store's delivery weekdays (if set) replace the company's
drop function if exists noodle.delivery_date_problem(uuid, date);
create or replace function noodle.delivery_date_problem(p_customer uuid, p_date date, p_location uuid default null) returns text
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare v_dow int := extract(isodow from p_date); v_fw text; v_cw smallint[];
begin
  if p_date < noodle.earliest_delivery_date() then return 'too_late'; end if;
  v_fw := coalesce((select value from noodle.settings where key = 'order_weekdays'), '');
  if v_fw <> '' and not (v_dow::text = any (string_to_array(replace(v_fw, ' ', ''), ','))) then return 'no_delivery_day'; end if;
  select delivery_weekdays into v_cw from noodle.customer_locations where id = p_location;
  if v_cw is null or cardinality(v_cw) = 0 then
    select delivery_weekdays into v_cw from noodle.customers where id = p_customer;
  end if;
  if v_cw is not null and cardinality(v_cw) > 0 and not (v_dow = any (v_cw)) then return 'not_your_day'; end if;
  if exists (select 1 from noodle.closed_days(p_date, p_date)) then return 'closed'; end if;
  return '';
end $$;

-- rules for the portal: + the stores this account can order for (each with its delivery weekdays)
create or replace function noodle.order_rules() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select jsonb_build_object(
    'earliest', noodle.earliest_delivery_date(),
    'cutoff', (select value from noodle.settings where key = 'order_cutoff_time'),
    'lead_days', (select value from noodle.settings where key = 'order_lead_days'),
    'weekdays', (select value from noodle.settings where key = 'order_weekdays'),
    'closed_dates', (select string_agg(day::text, ',' order by day) from noodle.closed_days(current_date, current_date + 400)),
    'closed_list', (select coalesce(jsonb_agg(jsonb_build_object('date', day, 'name', name) order by day), '[]'::jsonb)
                      from noodle.closed_days(current_date, current_date + 400)),
    'my_weekdays', (select to_jsonb(delivery_weekdays) from noodle.customers where id = noodle.my_customer_id()),
    'my_location', noodle.my_location_id(),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'address', l.address,
                                     'weekdays', l.delivery_weekdays) order by l.sort, l.name), '[]'::jsonb)
                    from noodle.customer_locations l
                   where l.customer_id = noodle.my_customer_id() and l.active
                     and (noodle.my_location_id() is null or l.id = noodle.my_location_id())))
$$;

-- place_order: + p_location_id. Customers with active stores must pick one; store accounts are fixed to theirs.
drop function if exists noodle.place_order(date, jsonb, text, uuid);
create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb, p_notes text default null,
                                              p_customer_id uuid default null, p_location_id uuid default null)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_cust uuid; v_loc uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean; v_problem text;
        v_staff boolean := noodle.is_staff();
        v_internal boolean := noodle.my_role() = 'restaurant';
begin
  if v_staff then v_cust := p_customer_id; else v_cust := noodle.my_customer_id(); end if;
  if v_cust is null then raise exception 'no customer account'; end if;
  if not exists (select 1 from noodle.customers where id = v_cust and active) then
    raise exception 'customer inactive';
  end if;
  if noodle.my_role() = 'customer' and (select terms_version from noodle.profiles where user_id = auth.uid())
       is distinct from (select value from noodle.settings where key = 'terms_version') then
    raise exception 'terms not accepted';
  end if;

  -- store
  v_loc := case when not v_staff and noodle.my_location_id() is not null then noodle.my_location_id() else p_location_id end;
  if v_loc is not null then
    if not exists (select 1 from noodle.customer_locations where id = v_loc and customer_id = v_cust and active) then
      raise exception 'store not available';
    end if;
  elsif exists (select 1 from noodle.customer_locations where customer_id = v_cust and active) then
    raise exception 'store required';
  end if;

  if p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if not v_staff then
    v_problem := noodle.delivery_date_problem(v_cust, p_delivery_date, v_loc);
    if v_problem <> '' then raise exception 'delivery date not allowed: %', v_problem; end if;
  end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, location_id, delivery_date, notes, status)
  values (v_cust, v_loc, p_delivery_date, p_notes,
          case when v_staff or v_internal then 'confirmed' else 'submitted' end)
  returning id into v_order;

  for l in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((l->>'qty')::numeric, 0) <= 0;
    select noodle.price_for(v_cust, p.id), p.min_order_qty,
           p.active and (p.visible_to_customers or v_staff)
      into v_price, v_min, v_ok
    from noodle.products p
    where p.id = (l->>'product_id')::uuid;
    if not coalesce(v_ok,false) then raise exception 'product not available'; end if;
    if not (v_internal or v_staff) and (l->>'qty')::numeric < v_min then
      raise exception 'below minimum order quantity';
    end if;
    insert into noodle.order_lines(order_id, product_id, qty, unit_price)
    values (v_order, (l->>'product_id')::uuid, (l->>'qty')::numeric, v_price);
  end loop;

  if not exists (select 1 from noodle.order_lines where order_id = v_order) then
    raise exception 'empty order';
  end if;
  return v_order;
end $$;

-- order emails / Slack: show "Company · Store", deliver to the store's address; store accounts only get their store's emails
create or replace function noodle.order_email_payload(p_order uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v jsonb;
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  select jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'no', o.no, 'status', o.status, 'delivery_date', o.delivery_date,
                                'notes', o.notes, 'created_at', o.created_at),
    'customer', jsonb_build_object('id', c.id, 'name', c.name || coalesce(' · ' || lo.name, ''), 'type', c.type, 'email', c.email,
                                   'address', coalesce(nullif(lo.address, ''), c.address),
                                   'phone', coalesce(nullif(lo.phone, ''), c.phone),
                                   'contact_person', coalesce(nullif(lo.contact_person, ''), c.contact_person)),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                 'name_hu', p.name_hu, 'name_en', p.name_en, 'name_zh', p.name_zh, 'unit', p.unit,
                 'qty', l.qty, 'unit_price', l.unit_price) order by p.sort, p.name_hu)
               from noodle.order_lines l join noodle.products p on p.id = l.product_id
               where l.order_id = o.id), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', pr.lang))
               from noodle.profiles pr join auth.users u on u.id = pr.user_id
               where pr.customer_id = c.id and pr.role in ('customer', 'restaurant')
                 and (pr.location_id is null or pr.location_id is not distinct from o.location_id)), '[]'::jsonb),
    'sent', coalesce((select jsonb_agg(distinct kind) from noodle.email_log
               where order_id = o.id and status = 'sent'), '[]'::jsonb),
    'settings', (select jsonb_object_agg(key, value) from noodle.settings
               where key like 'email\_%' or key like 'slack\_%' or key = 'app_url'))
  into v
  from noodle.orders o join noodle.customers c on c.id = o.customer_id
  left join noodle.customer_locations lo on lo.id = o.location_id
  where o.id = p_order;
  return v;
end $$;

-- operation log for stores too
drop trigger if exists audit on noodle.customer_locations;
create trigger audit after insert or update or delete on noodle.customer_locations
  for each row execute function noodle.audit_trigger();

revoke execute on all functions in schema noodle from anon, public;
revoke execute on function noodle.price_for(uuid, uuid) from authenticated;
revoke execute on function noodle.delivery_date_problem(uuid, date, uuid) from authenticated;
revoke execute on function noodle.closed_days(date, date) from authenticated;
revoke execute on function noodle.order_email_payload(uuid, text) from authenticated;
revoke execute on function noodle.notify_settings(text) from authenticated;
revoke execute on function noodle.audit_trigger() from authenticated;
revoke execute on function noodle.guard_profile_location() from authenticated;
grant execute on function noodle.public_info() to anon, authenticated;
grant execute on function noodle.my_location_id() to authenticated;
grant execute on function noodle.order_rules() to authenticated;
grant execute on function noodle.cancel_my_order(uuid) to authenticated;
grant execute on function noodle.place_order(date, jsonb, text, uuid, uuid) to authenticated;
grant execute on function noodle.order_email_payload(uuid, text) to service_role;

notify pgrst, 'reload schema';
