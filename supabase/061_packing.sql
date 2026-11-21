-- =====================================================================
-- 061 · 打包 / 分装
--   Per order line: pack_vacuum (vacuum bags, usually 2–3 kg) and portion_g (split into portions of N g,
--   with or without vacuum). Each costs a fee per kg, set in the settings (packing_vacuum_fee,
--   packing_portion_fee, default 150 Ft/kg each, so portions + vacuum = 300 Ft/kg). Own restaurants
--   (internal customers) pay no packing fee. The fee is copied onto the line when it is ordered.
--   customers.pack_vacuum / portion_g: the customer's default (internal restaurants except Tigris: vacuum).
--   A line inserted without packing (pack_vacuum null) gets the customer's default (trigger), so
--   change requests and staff orders follow it too. set_line_packing: staff change a line's packing.
--   monthly_report: values include the packing fees (pack_value separately per store × product).
-- =====================================================================
alter table noodle.customers add column if not exists pack_vacuum boolean not null default false;
alter table noodle.customers add column if not exists portion_g integer check (portion_g is null or portion_g between 10 and 10000);
alter table noodle.order_lines add column if not exists pack_vacuum boolean;
alter table noodle.order_lines add column if not exists portion_g integer check (portion_g is null or portion_g between 10 and 10000);
alter table noodle.order_lines add column if not exists vacuum_fee numeric(10,2);
alter table noodle.order_lines add column if not exists portion_fee numeric(10,2);
update noodle.order_lines set pack_vacuum = false, vacuum_fee = 0, portion_fee = 0 where pack_vacuum is null;

-- own restaurants get vacuum bags, except Tigris
update noodle.customers set pack_vacuum = true where type = 'internal' and name not ilike '%tigris%';

insert into noodle.settings (key, value) values
  ('packing_vacuum_fee', '150'),
  ('packing_portion_fee', '150'),
  ('packing_bag_text', '2–3 kg')
on conflict (key) do nothing;

create or replace function noodle.order_lines_packing() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare c noodle.customers; v_vac numeric; v_por numeric;
begin
  select cu.* into c from noodle.orders o join noodle.customers cu on cu.id = o.customer_id where o.id = new.order_id;
  if tg_op = 'INSERT' and new.pack_vacuum is null then
    new.pack_vacuum := coalesce(c.pack_vacuum, false);
    new.portion_g := c.portion_g;
  end if;
  new.pack_vacuum := coalesce(new.pack_vacuum, false);
  if new.portion_g is not null and new.portion_g <= 0 then new.portion_g := null; end if;
  -- fees: set when ordered (or copied on a split); recalculated when the packing changes
  if tg_op = 'INSERT' and new.vacuum_fee is not null and new.portion_fee is not null then return new; end if;
  if tg_op = 'UPDATE' and new.pack_vacuum is not distinct from old.pack_vacuum and new.portion_g is not distinct from old.portion_g then return new; end if;
  if c.type = 'internal' then
    new.vacuum_fee := 0; new.portion_fee := 0;
  else
    v_vac := coalesce(nullif((select value from noodle.settings where key = 'packing_vacuum_fee'), '')::numeric, 0);
    v_por := coalesce(nullif((select value from noodle.settings where key = 'packing_portion_fee'), '')::numeric, 0);
    new.vacuum_fee := case when new.pack_vacuum then v_vac else 0 end;
    new.portion_fee := case when new.portion_g is not null then v_por else 0 end;
  end if;
  return new;
end $$;
revoke execute on function noodle.order_lines_packing() from public, anon, authenticated;
drop trigger if exists packing on noodle.order_lines;
create trigger packing before insert or update of pack_vacuum, portion_g on noodle.order_lines
  for each row execute function noodle.order_lines_packing();

-- staff change the packing of one line (open orders only)
create or replace function noodle.set_line_packing(p_line uuid, p_vacuum boolean, p_portion_g integer)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare l noodle.order_lines; o noodle.orders; v_name text;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into l from noodle.order_lines where id = p_line for update;
  if l.id is null then raise exception 'line not found'; end if;
  select * into o from noodle.orders where id = l.order_id;
  if o.status not in ('submitted', 'confirmed', 'ready') then raise exception 'order can no longer be changed'; end if;
  if l.pack_vacuum = coalesce(p_vacuum, false) and l.portion_g is not distinct from nullif(p_portion_g, 0) then return; end if;
  update noodle.order_lines set pack_vacuum = coalesce(p_vacuum, false), portion_g = nullif(p_portion_g, 0) where id = l.id;
  select name_hu into v_name from noodle.products where id = l.product_id;
  perform noodle.notify_order_change(o.id, format('📦 %s: %s', v_name,
    concat_ws(' + ', case when p_vacuum then 'vákuum' end, case when nullif(p_portion_g, 0) is not null then p_portion_g || ' g adag' end, case when not coalesce(p_vacuum, false) and nullif(p_portion_g, 0) is null then 'nincs csomagolás' end)));
end $$;
revoke execute on function noodle.set_line_packing(uuid, boolean, integer) from public, anon;
grant execute on function noodle.set_line_packing(uuid, boolean, integer) to authenticated;

create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb, p_notes text default null, p_customer_id uuid default null,
                                              p_location_id uuid default null, p_urgent boolean default false)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $function$
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

  if p_delivery_date < (now() at time zone 'Europe/Budapest')::date then raise exception 'delivery date in the past'; end if;
  if v_staff then
    v_urgent := coalesce(p_urgent, false);
  else
    v_problem := noodle.delivery_date_problem(v_cust, p_delivery_date, v_loc);
    if coalesce(p_urgent, false) then
      if v_mode = 'off' or (v_mode = 'internal' and not v_internal) then raise exception 'urgent orders not available'; end if;
      -- urgent: no date rule applies (only not in the past); the factory confirms it
      v_problem := '';
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
    -- packing: when the line says nothing, the customer's default applies (trigger order_lines_packing)
    insert into noodle.order_lines(order_id, product_id, qty, unit_price, pack_vacuum, portion_g)
    values (v_order, (l->>'product_id')::uuid, (l->>'qty')::numeric, v_price,
            case when l ? 'pack_vacuum' then coalesce((l->>'pack_vacuum')::boolean, false) end,
            case when l ? 'pack_vacuum' then nullif((l->>'portion_g')::int, 0) end);
  end loop;

  if not exists (select 1 from noodle.order_lines where order_id = v_order) then
    raise exception 'empty order';
  end if;
  return v_order;
end $function$;

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
      insert into noodle.order_lines (order_id, product_id, qty, unit_price, pack_vacuum, portion_g, vacuum_fee, portion_fee)
      values (v_new, l.product_id, v_later, l.unit_price, l.pack_vacuum, l.portion_g, l.vacuum_fee, l.portion_fee);
    end if;
  end loop;
  if not v_any then raise exception 'nothing to split'; end if;
  if not exists (select 1 from noodle.order_lines where order_id = o.id) then raise exception 'keep at least one product'; end if;

  select string_agg(p.name_hu || ' ' || trim_scale(x.qty), ', ') into v_names
    from noodle.order_lines x join noodle.products p on p.id = x.product_id where x.order_id = v_new;
  perform noodle.notify_order_change(o.id, format('✂️ %s → #%s (%s)', v_names, (select no from noodle.orders where id = v_new), to_char(p_delivery_date, 'YYYY-MM-DD')));
  return v_new;
end $$;

create or replace function noodle.monthly_report(p_month date) returns jsonb
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month')::date;
  t_from timestamptz := (v_from::timestamp at time zone 'Europe/Budapest');
  t_to   timestamptz := (v_to::timestamp at time zone 'Europe/Budapest');
  v jsonb;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;

  select jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'), 'from', v_from, 'to', v_to - 1,

    'orders', (select jsonb_build_object(
        'delivered', count(*) filter (where status = 'delivered'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'open',      count(*) filter (where status in ('submitted', 'confirmed', 'ready')),
        'urgent',    count(*) filter (where urgent and status <> 'cancelled'),
        'customers', count(distinct customer_id) filter (where status = 'delivered'))
      from noodle.orders where delivery_date >= v_from and delivery_date < v_to),

    'sales_by_product', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', p.name_hu, 'unit', p.unit,
                 'qty', sum(coalesce(l.delivered_qty, l.qty)),
                 'value', sum(coalesce(l.delivered_qty, l.qty) * (l.unit_price + coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0))),
                 'internal_qty', sum(coalesce(l.delivered_qty, l.qty)) filter (where c.type = 'internal'),
                 'external_qty', sum(coalesce(l.delivered_qty, l.qty)) filter (where c.type <> 'internal')) x
        from noodle.orders o join noodle.order_lines l on l.order_id = o.id
        join noodle.products p on p.id = l.product_id join noodle.customers c on c.id = o.customer_id
        where o.status = 'delivered' and o.delivery_date >= v_from and o.delivery_date < v_to
        group by p.id) s), '[]'::jsonb),

    'sales_by_customer', coalesce((select jsonb_agg(x order by (x->>'qty')::numeric desc) from (
        select jsonb_build_object('name', c.name, 'type', c.type, 'orders', count(distinct o.id),
                 'qty', sum(coalesce(l.delivered_qty, l.qty)),
                 'value', sum(coalesce(l.delivered_qty, l.qty) * (l.unit_price + coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0)))) x
        from noodle.orders o join noodle.order_lines l on l.order_id = o.id join noodle.customers c on c.id = o.customer_id
        where o.status = 'delivered' and o.delivery_date >= v_from and o.delivery_date < v_to
        group by c.id) s), '[]'::jsonb),

    -- every restaurant / store × product (new products show up automatically)
    'sales_by_store_product', coalesce((select jsonb_agg(x order by x->>'customer', x->>'store' nulls first, (x->>'sort')::int) from (
        select jsonb_build_object('customer', c.name, 'customer_id', c.id, 'type', c.type, 'store', cl.name, 'location_id', cl.id,
                 'product', p.name_hu, 'product_id', p.id, 'sort', coalesce(p.sort, 0), 'unit', p.unit,
                 'qty', sum(coalesce(l.delivered_qty, l.qty)),
                 'value', sum(coalesce(l.delivered_qty, l.qty) * (l.unit_price + coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0))),
                 'pack_value', sum(coalesce(l.delivered_qty, l.qty) * (coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0)))) x
        from noodle.orders o join noodle.order_lines l on l.order_id = o.id
        join noodle.customers c on c.id = o.customer_id join noodle.products p on p.id = l.product_id
        left join noodle.customer_locations cl on cl.id = o.location_id
        where o.status = 'delivered' and o.delivery_date >= v_from and o.delivery_date < v_to
        group by c.id, cl.id, p.id) s), '[]'::jsonb),

    'production', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', p.name_hu, 'unit', p.unit, 'runs', count(*), 'batches', sum(b.batches),
                 'actual', sum(b.actual_qty), 'theoretical', sum(b.batches * p.batch_yield),
                 'loss_pct', case when sum(b.batches * p.batch_yield) > 0
                                  then round((1 - sum(b.actual_qty) / sum(b.batches * p.batch_yield)) * 100, 1) end) x
        from noodle.production_batches b join noodle.products p on p.id = b.product_id
        where b.status = 'done' and b.done_at >= t_from and b.done_at < t_to
        group by p.id) s), '[]'::jsonb),

    'materials', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', m.name_hu, 'unit', m.unit, 'cost', m.cost_per_unit,
                 'used',      -coalesce(sum(s.qty) filter (where s.reason = 'production_use' and s.created_at >= t_from and s.created_at < t_to), 0),
                 'bought',     coalesce(sum(s.qty) filter (where s.reason = 'purchase' and s.created_at >= t_from and s.created_at < t_to), 0),
                 'adjusted',   coalesce(sum(s.qty) filter (where s.reason in ('count', 'waste') and s.created_at >= t_from and s.created_at < t_to), 0),
                 'end_stock',  coalesce(sum(s.qty) filter (where s.created_at < t_to), 0),
                 'end_value',  coalesce(sum(s.qty) filter (where s.created_at < t_to), 0) * m.cost_per_unit) x
        from noodle.materials m left join noodle.stock_movements s on s.material_id = m.id
        where m.active and m.stock_as is null and m.track_stock
        group by m.id
        having coalesce(sum(s.qty) filter (where s.created_at < t_to), 0) <> 0
            or count(*) filter (where s.created_at >= t_from and s.created_at < t_to) > 0) s), '[]'::jsonb),

    'purchases', (select jsonb_build_object('orders', count(distinct po.id),
                    'value', coalesce(sum(l.received_qty * l.unit_price), 0))
      from noodle.purchase_orders po join noodle.purchase_order_lines l on l.po_id = po.id
      where po.status = 'received' and po.received_at >= t_from and po.received_at < t_to),

    'products', coalesce((select jsonb_agg(jsonb_build_object('name', p.name_hu, 'unit', p.unit,
                    'end_stock', (select coalesce(sum(qty), 0) from noodle.stock_movements s where s.product_id = p.id and s.created_at < t_to))
                    order by p.sort)
      from noodle.products p where p.active), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke execute on function noodle.monthly_report(date) from public, anon;
grant execute on function noodle.monthly_report(date) to authenticated;

-- the ordering page shows the packing fees and bag size
create or replace function noodle.public_info() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $function$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from noodle.settings
  where key in ('company_name','company_address','company_reg_no','company_court','company_tax_no',
                'company_email','company_phone','company_authority','terms_version',
                'order_cutoff_time','order_lead_days',
                'packing_vacuum_fee','packing_portion_fee','packing_bag_text')
$function$;
notify pgrst, 'reload schema';

-- order e-mails / Slack: each line carries its packing
do $do$
declare d text := pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'noodle' and p.proname = 'order_email_payload'));
  a text := $x$'qty', l.qty, 'unit_price', l.unit_price) order by p.sort, p.name_hu)$x$;
begin
  if position(a in d) = 0 then raise notice 'order_email_payload: already changed'; return; end if;
  d := replace(d, a, $x$'qty', l.qty, 'unit_price', l.unit_price, 'pack_vacuum', l.pack_vacuum, 'portion_g', l.portion_g,
                 'pack_fee', coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0)) order by p.sort, p.name_hu)$x$);
  execute d;
end $do$;
