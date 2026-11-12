-- =====================================================================
-- 032 · 紧急订单：不是送货日也能下单
--   place_order(..., p_urgent): an urgent order may be for a day that is not a delivery day
--   (factory weekdays or the customer's / store's own days). The earliest-date rule (cut-off,
--   lead days) and closed days still apply. Urgent orders always wait for the factory to confirm,
--   also for own restaurants. Setting urgent_orders: all (default) | internal | off.
-- =====================================================================
alter table noodle.orders add column if not exists urgent boolean not null default false;
insert into noodle.settings(key, value) values ('urgent_orders', 'all') on conflict (key) do nothing;

drop function if exists noodle.place_order(date, jsonb, text, uuid, uuid);
create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb, p_notes text default null,
  p_customer_id uuid default null, p_location_id uuid default null, p_urgent boolean default false)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_cust uuid; v_loc uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean; v_problem text;
        v_staff boolean := noodle.is_staff();
        v_internal boolean := noodle.my_role() = 'restaurant';
        v_urgent boolean := false;
        v_mode text := coalesce((select value from noodle.settings where key = 'urgent_orders'), 'all');
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

  v_loc := case when not v_staff and noodle.my_location_id() is not null then noodle.my_location_id() else p_location_id end;
  if v_loc is not null then
    if not exists (select 1 from noodle.customer_locations where id = v_loc and customer_id = v_cust and active) then
      raise exception 'store not available';
    end if;
  elsif exists (select 1 from noodle.customer_locations where customer_id = v_cust and active) then
    raise exception 'store required';
  end if;

  if p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if v_staff then
    v_urgent := coalesce(p_urgent, false);
  else
    v_problem := noodle.delivery_date_problem(v_cust, p_delivery_date, v_loc);
    if coalesce(p_urgent, false) then
      if v_mode = 'off' or (v_mode = 'internal' and not v_internal) then raise exception 'urgent orders not available'; end if;
      -- urgent: only the weekday rules are lifted
      if v_problem in ('no_delivery_day', 'not_your_day') then v_problem := ''; end if;
      v_urgent := true;
    end if;
    if v_problem <> '' then raise exception 'delivery date not allowed: %', v_problem; end if;
  end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, location_id, delivery_date, notes, status, urgent)
  values (v_cust, v_loc, p_delivery_date, p_notes,
          case when v_staff or (v_internal and not v_urgent) then 'confirmed' else 'submitted' end, v_urgent)
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

-- the portal needs to know whether this account may place urgent orders
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
    'urgent', case coalesce((select value from noodle.settings where key = 'urgent_orders'), 'all')
                when 'all' then true when 'internal' then noodle.my_role() = 'restaurant' else false end,
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'address', l.address,
                                     'weekdays', l.delivery_weekdays) order by l.sort, l.name), '[]'::jsonb)
                    from noodle.customer_locations l
                   where l.customer_id = noodle.my_customer_id() and l.active
                     and (noodle.my_location_id() is null or l.id = noodle.my_location_id())))
$$;

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
                                'notes', o.notes, 'created_at', o.created_at, 'urgent', o.urgent),
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
               from noodle.profile_customers pc
               join noodle.profiles pr on pr.user_id = pc.user_id and pr.role in ('customer', 'restaurant')
               join auth.users u on u.id = pc.user_id
               where pc.customer_id = c.id
                 and (pc.location_id is null or pc.location_id is not distinct from o.location_id)), '[]'::jsonb),
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

revoke execute on function noodle.place_order(date, jsonb, text, uuid, uuid, boolean) from public, anon;
grant execute on function noodle.place_order(date, jsonb, text, uuid, uuid, boolean) to authenticated;
revoke execute on function noodle.order_email_payload(uuid, text) from public, anon, authenticated;
grant execute on function noodle.order_email_payload(uuid, text) to service_role;
notify pgrst, 'reload schema';
