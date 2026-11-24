-- =====================================================================
-- 068 · 样品按订单标记 / Samples marked per order
--   Samples are delivered to the real customer (their name and address on the delivery note), so the order
--   stays under that customer and is marked orders.is_sample: all prices 0, "INGYENES MINTA" on the note,
--   left out of the month-end invoice basis (store × product) and listed under "samples" instead;
--   counts as samples on the Costs page. The "Minta / 样品" account stays for guests with no customer record.
--   set_order_sample(order, bool): staff; marking sets every line's price and packing fees to 0,
--   unmarking restores the price list price (packing fees stay 0).
--   Order #29 moved back from the sample account to Hachi and marked as a sample.
-- =====================================================================
alter table noodle.orders add column if not exists is_sample boolean not null default false;

create or replace function noodle.set_order_sample(p_order uuid, p_sample boolean) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status = 'cancelled' then raise exception 'order can no longer be changed'; end if;
  update noodle.orders set is_sample = p_sample where id = o.id;
  if p_sample then
    update noodle.order_lines set unit_price = 0, vacuum_fee = 0, portion_fee = 0 where order_id = o.id;
  else
    update noodle.order_lines set unit_price = coalesce(noodle.price_for(o.customer_id, product_id), 0) where order_id = o.id;
  end if;
end $$;
revoke execute on function noodle.set_order_sample(uuid, boolean) from public, anon;
grant execute on function noodle.set_order_sample(uuid, boolean) to authenticated;

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
          and not o.is_sample and not c.is_sample
        group by c.id, cl.id, p.id) s), '[]'::jsonb),

    -- free samples (not invoiced): per customer and product
    'samples', coalesce((select jsonb_agg(x order by x->>'customer', x->>'product') from (
        select jsonb_build_object('customer', c.name, 'product', p.name_hu, 'unit', p.unit,
                 'qty', sum(coalesce(l.delivered_qty, l.qty)), 'orders', count(distinct o.id)) x
        from noodle.orders o join noodle.order_lines l on l.order_id = o.id
        join noodle.customers c on c.id = o.customer_id join noodle.products p on p.id = l.product_id
        where o.status = 'delivered' and o.delivery_date >= v_from and o.delivery_date < v_to
          and (o.is_sample or c.is_sample)
        group by c.id, p.id) s), '[]'::jsonb),

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

create or replace function noodle.cost_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare
  t_from timestamptz := (p_from::timestamp at time zone 'Europe/Budapest');
  t_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Europe/Budapest');
begin
  if not noodle.is_cost_viewer() then raise exception 'not allowed'; end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'bad period'; end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from noodle.cost_settings),
    'production', (select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
        select jsonb_build_object('name', p.name_hu, 'batches', sum(b.batches),
                 'actual', sum(b.actual_qty), 'theoretical', sum(b.batches * p.batch_yield),
                 'unweighed', count(*) filter (where abs(b.actual_qty - b.batches * p.batch_yield) < 0.01)) x
        from noodle.production_batches b join noodle.products p on p.id = b.product_id
        where b.status = 'done' and b.actual_qty is not null and b.done_at >= t_from and b.done_at < t_to
        group by p.id, p.name_hu) s),
    'materials', (select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') from (
        select jsonb_build_object('name', m.name_hu, 'unit', m.unit, 'used', -sum(s.qty),
                 'price', m.cost_per_unit, 'value', -sum(s.qty) * coalesce(m.cost_per_unit, 0)) x
        from noodle.stock_movements s join noodle.materials m on m.id = s.material_id
        where s.reason = 'production_use' and s.created_at >= t_from and s.created_at < t_to
        group by m.id, m.name_hu, m.unit, m.cost_per_unit) s),
    -- each finished batch: Budapest day, who pressed "finish", kg (for kg per person and per day)
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('day', (b.done_at at time zone 'Europe/Budapest')::date,
                 'by', pr.display_name, 'kg', b.actual_qty) order by b.done_at), '[]')
        from noodle.production_batches b left join noodle.profiles pr on pr.user_id = b.done_by
        where b.status = 'done' and b.actual_qty is not null and b.done_at >= t_from and b.done_at < t_to),
    -- type: 'internal' (own restaurants), 'wholesale' (external), 'sample' (the sample account)
    'deliveries', (select coalesce(jsonb_agg(x), '[]') from (
        select jsonb_build_object('type', k,
                 'kg', sum(q), 'value', sum(v)) x
        from (select case when c.is_sample or o.is_sample then 'sample' else c.type::text end k,
                     coalesce(l.delivered_qty, l.qty) q,
                     coalesce(l.delivered_qty, l.qty) * (l.unit_price + coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0)) v
              from noodle.orders o join noodle.customers c on c.id = o.customer_id join noodle.order_lines l on l.order_id = o.id
              where o.status = 'delivered' and o.delivery_date between p_from and p_to) d
        group by k) s)
  );
end $$;
revoke execute on function noodle.cost_report(date, date) from public, anon;
grant execute on function noodle.cost_report(date, date) to authenticated;

update noodle.orders set customer_id = (select id from noodle.customers where name = 'Hachi'), location_id = null,
       is_sample = true, notes = 'Samples'
 where no = 29 and customer_id = (select id from noodle.customers where is_sample);

notify pgrst, 'reload schema';
