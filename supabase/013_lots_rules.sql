-- =====================================================================
-- 013 · 原料批号先进先出 + 过期提醒 + 下单规则（截单时间、送货日）
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Raw-material lots
--    A lot = (material, lot_no, expiry_date) in the stock ledger. Receiving creates it,
--    production / waste / counts take from it, earliest expiry first (FIFO by expiry, then age).
-- ---------------------------------------------------------------------

create or replace view noodle.material_lots with (security_invoker = on) as
select s.material_id, s.lot_no, s.expiry_date,
       min(s.created_at) filter (where s.qty > 0) as received_at,
       sum(s.qty)::numeric(12,3) as remaining,
       m.name_zh, m.name_en, m.name_hu, m.unit
from noodle.stock_movements s
join noodle.materials m on m.id = s.material_id
where s.material_id is not null
group by s.material_id, s.lot_no, s.expiry_date, m.name_zh, m.name_en, m.name_hu, m.unit
having sum(s.qty) > 0.0005;

-- take p_qty of a material out of stock, lot by lot (earliest expiry first).
-- Production never takes expired lots automatically (p_include_expired = false): they stay
-- in stock, flagged on the dashboard, until someone books them as waste.
-- Whatever no lot can cover is booked without a lot (stock may go negative, like before).
drop function if exists noodle.take_material(uuid, numeric, text, uuid, text, text);
create or replace function noodle.take_material(p_material uuid, p_qty numeric, p_reason text,
                                                p_ref uuid default null, p_note text default null,
                                                p_lot text default null, p_include_expired boolean default false)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare r record; v_left numeric := p_qty; v_take numeric;
begin
  if p_qty is null or p_qty <= 0 then return; end if;
  for r in
    select lot_no, expiry_date, remaining from noodle.material_lots
    where material_id = p_material
      and (p_lot is null or lot_no is not distinct from p_lot)
      and (p_lot is not null or p_include_expired or expiry_date is null
           or expiry_date >= (now() at time zone 'Europe/Budapest')::date)
    order by (lot_no is null), expiry_date nulls last, received_at nulls last
  loop
    exit when v_left <= 0;
    v_take := least(v_left, r.remaining);
    insert into noodle.stock_movements(material_id, qty, reason, ref_id, lot_no, expiry_date, note)
    values (p_material, -v_take, p_reason, p_ref, r.lot_no, r.expiry_date, p_note);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0.0005 then
    insert into noodle.stock_movements(material_id, qty, reason, ref_id, note)
    values (p_material, -v_left, p_reason, p_ref, p_note);
  end if;
end $$;

-- receiving: a line without a lot number gets "P<po no>" so it can still be traced
create or replace function noodle.receive_purchase_order(p_po_id uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare l jsonb; pl noodle.purchase_order_lines; v_qty numeric; v_no bigint; v_lot text;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select no into v_no from noodle.purchase_orders where id = p_po_id and status in ('draft','ordered') for update;
  if not found then raise exception 'purchase order not open'; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    select * into pl from noodle.purchase_order_lines
      where id = (l->>'line_id')::uuid and po_id = p_po_id;
    if pl.id is null then raise exception 'line % not in PO', l->>'line_id'; end if;
    v_qty := coalesce((l->>'received_qty')::numeric, pl.qty);
    v_lot := coalesce(nullif(trim(l->>'lot_no'),''), 'P' || v_no);
    update noodle.purchase_order_lines
       set received_qty = v_qty, lot_no = v_lot,
           expiry_date  = nullif(l->>'expiry_date','')::date
     where id = pl.id;
    if v_qty > 0 then
      insert into noodle.stock_movements(material_id, qty, reason, ref_id, lot_no, expiry_date)
      values (pl.material_id, v_qty, 'purchase', p_po_id, v_lot, nullif(l->>'expiry_date','')::date);
      if pl.unit_price > 0 then
        update noodle.materials set cost_per_unit = pl.unit_price where id = pl.material_id;
      end if;
    end if;
  end loop;

  update noodle.purchase_orders set status = 'received', received_at = now() where id = p_po_id;
end $$;

-- finishing a batch: raw materials come out lot by lot; the batch is linked by ref_id,
-- and each movement carries the raw-material lot it used (that is what the trace page shows)
create or replace function noodle.complete_production(p_batch_id uuid, p_actual_qty numeric, p_lot_no text default null)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare b noodle.production_batches; v_lot text; v_exp date; r record;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into b from noodle.production_batches where id = p_batch_id for update;
  if b.id is null or b.status <> 'planned' then raise exception 'batch not open'; end if;
  if p_actual_qty is null or p_actual_qty < 0 then raise exception 'invalid quantity'; end if;

  v_lot := coalesce(nullif(p_lot_no,''), to_char(now() at time zone 'Europe/Budapest','YYMMDD') || '-' || b.no);
  select current_date + shelf_life_days into v_exp from noodle.products where id = b.product_id;

  for r in select material_id, qty_per_batch * b.batches as qty
           from noodle.recipe_lines where product_id = b.product_id order by sort loop
    perform noodle.take_material(r.material_id, r.qty, 'production_use', b.id, 'B' || b.no || ' ' || v_lot);
  end loop;

  if p_actual_qty > 0 then
    insert into noodle.stock_movements(product_id, qty, reason, ref_id, lot_no, expiry_date)
    values (b.product_id, p_actual_qty, 'production_out', b.id, v_lot, v_exp);
  end if;

  update noodle.production_batches
     set status = 'done', actual_qty = p_actual_qty, lot_no = v_lot, done_at = now()
   where id = b.id;
end $$;

-- stock count / waste from the inventory page.
--   materials: decreases come out lot by lot (or from the chosen lot), increases are booked
--   as a counting lot ("COUNT-YYMMDD") with the given expiry date
--   products: booked as before (no lot split)
create or replace function noodle.adjust_stock(p_kind text, p_id uuid, p_mode text, p_qty numeric,
                                               p_note text default null, p_lot text default null,
                                               p_expiry date default null)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_on numeric; v_delta numeric; v_reason text := case when p_mode = 'waste' then 'waste' else 'count' end;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'invalid quantity'; end if;
  if p_kind = 'material' then
    if p_mode = 'count' and p_lot is not null then
      select coalesce(sum(qty),0) into v_on from noodle.stock_movements where material_id = p_id and lot_no is not distinct from p_lot;
    else
      select coalesce(sum(qty),0) into v_on from noodle.stock_movements where material_id = p_id;
    end if;
    v_delta := case when p_mode = 'waste' then -p_qty else p_qty - v_on end;
    if v_delta < 0 then
      perform noodle.take_material(p_id, -v_delta, v_reason, null, p_note, p_lot, true);
    elsif v_delta > 0 then
      insert into noodle.stock_movements(material_id, qty, reason, lot_no, expiry_date, note)
      values (p_id, v_delta, v_reason,
              coalesce(p_lot, 'COUNT-' || to_char(now() at time zone 'Europe/Budapest','YYMMDD')),
              p_expiry, p_note);
    end if;
  elsif p_kind = 'product' then
    select coalesce(sum(qty),0) into v_on from noodle.stock_movements where product_id = p_id;
    v_delta := case when p_mode = 'waste' then -p_qty else p_qty - v_on end;
    if v_delta <> 0 then
      insert into noodle.stock_movements(product_id, qty, reason, note) values (p_id, v_delta, v_reason, p_note);
    end if;
  else
    raise exception 'bad kind';
  end if;
end $$;

insert into noodle.settings (key, value) values
  ('lot_expiry_warn_days', '14')        -- warn this many days before a raw-material lot expires
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- B. Ordering rules
--    earliest delivery = today + lead days, +1 day after the cutoff time (Budapest time)
--    delivery only on the factory's delivery weekdays and the customer's own weekdays (if set)
--    weekdays: 1 = Monday … 7 = Sunday (ISO). Staff are not bound by these rules.
-- ---------------------------------------------------------------------
alter table noodle.customers add column if not exists delivery_weekdays smallint[];

insert into noodle.settings (key, value) values
  ('order_cutoff_time', '14:00'),
  ('order_lead_days', '1'),
  ('order_weekdays', '1,2,3,4,5,6'),
  ('order_closed_dates', '')            -- e.g. 2026-12-24,2026-12-25
on conflict (key) do nothing;

create or replace function noodle.earliest_delivery_date() returns date
language sql stable security definer set search_path = noodle, pg_temp as $$
  with s as (
    select coalesce(nullif((select value from noodle.settings where key = 'order_lead_days'),'')::int, 1) as lead,
           coalesce(nullif((select value from noodle.settings where key = 'order_cutoff_time'),''), '23:59')::time as cutoff,
           (now() at time zone 'Europe/Budapest') as local_now)
  select (local_now::date + lead + case when local_now::time >= cutoff then 1 else 0 end)::date from s
$$;

-- '' when the date is fine, otherwise a short reason code
create or replace function noodle.delivery_date_problem(p_customer uuid, p_date date) returns text
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare v_dow int := extract(isodow from p_date); v_fw text; v_cw smallint[];
begin
  if p_date < noodle.earliest_delivery_date() then return 'too_late'; end if;
  v_fw := coalesce((select value from noodle.settings where key = 'order_weekdays'), '');
  if v_fw <> '' and not (v_dow::text = any (string_to_array(replace(v_fw, ' ', ''), ','))) then return 'no_delivery_day'; end if;
  select delivery_weekdays into v_cw from noodle.customers where id = p_customer;
  if v_cw is not null and cardinality(v_cw) > 0 and not (v_dow = any (v_cw)) then return 'not_your_day'; end if;
  if p_date::text = any (string_to_array(replace(coalesce((select value from noodle.settings where key = 'order_closed_dates'), ''), ' ', ''), ',')) then
    return 'closed';
  end if;
  return '';
end $$;

create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb,
                                              p_notes text default null, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_cust uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean; v_problem text;
        v_staff boolean := noodle.is_staff();
        v_internal boolean := noodle.my_role() = 'restaurant';
begin
  if v_staff then v_cust := p_customer_id; else v_cust := noodle.my_customer_id(); end if;
  if v_cust is null then raise exception 'no customer account'; end if;
  if not exists (select 1 from noodle.customers where id = v_cust and active) then
    raise exception 'customer inactive';
  end if;
  if p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if not v_staff then
    v_problem := noodle.delivery_date_problem(v_cust, p_delivery_date);
    if v_problem <> '' then raise exception 'delivery date not allowed: %', v_problem; end if;
  end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, delivery_date, notes, status)
  values (v_cust, p_delivery_date, p_notes,
          case when v_staff or v_internal then 'confirmed' else 'submitted' end)
  returning id into v_order;

  for l in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((l->>'qty')::numeric, 0) <= 0;
    select coalesce(cp.price, p.base_price), p.min_order_qty,
           p.active and (p.visible_to_customers or v_staff)
      into v_price, v_min, v_ok
    from noodle.products p
    left join noodle.customer_prices cp on cp.product_id = p.id and cp.customer_id = v_cust
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

-- customers read their own customer row already; settings are staff-only, so the portal reads
-- the ordering rules through this function
create or replace function noodle.order_rules() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select jsonb_build_object(
    'earliest', noodle.earliest_delivery_date(),
    'cutoff', (select value from noodle.settings where key = 'order_cutoff_time'),
    'lead_days', (select value from noodle.settings where key = 'order_lead_days'),
    'weekdays', (select value from noodle.settings where key = 'order_weekdays'),
    'closed_dates', (select value from noodle.settings where key = 'order_closed_dates'),
    'my_weekdays', (select to_jsonb(delivery_weekdays) from noodle.customers where id = noodle.my_customer_id()))
$$;

revoke execute on function noodle.take_material(uuid, numeric, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function noodle.adjust_stock(text, uuid, text, numeric, text, text, date) to authenticated;
grant execute on function noodle.order_rules() to authenticated;
grant execute on function noodle.earliest_delivery_date() to authenticated;
revoke execute on function noodle.delivery_date_problem(uuid, date) from public, anon, authenticated;
grant select on noodle.material_lots to authenticated;
revoke execute on all functions in schema noodle from anon, public;

notify pgrst, 'reload schema';
