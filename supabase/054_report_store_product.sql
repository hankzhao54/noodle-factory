-- =====================================================================
-- 054 · 月底报告：每个店 × 每个产品
--   monthly_report gains sales_by_store_product: delivered kg and net value per customer, store
--   (customer_locations, when the order has one) and product. Products are not hard-coded, so new
--   products appear on their own.
-- =====================================================================
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
                 'value', sum(coalesce(l.delivered_qty, l.qty) * l.unit_price),
                 'internal_qty', sum(coalesce(l.delivered_qty, l.qty)) filter (where c.type = 'internal'),
                 'external_qty', sum(coalesce(l.delivered_qty, l.qty)) filter (where c.type <> 'internal')) x
        from noodle.orders o join noodle.order_lines l on l.order_id = o.id
        join noodle.products p on p.id = l.product_id join noodle.customers c on c.id = o.customer_id
        where o.status = 'delivered' and o.delivery_date >= v_from and o.delivery_date < v_to
        group by p.id) s), '[]'::jsonb),

    'sales_by_customer', coalesce((select jsonb_agg(x order by (x->>'qty')::numeric desc) from (
        select jsonb_build_object('name', c.name, 'type', c.type, 'orders', count(distinct o.id),
                 'qty', sum(coalesce(l.delivered_qty, l.qty)),
                 'value', sum(coalesce(l.delivered_qty, l.qty) * l.unit_price)) x
        from noodle.orders o join noodle.order_lines l on l.order_id = o.id join noodle.customers c on c.id = o.customer_id
        where o.status = 'delivered' and o.delivery_date >= v_from and o.delivery_date < v_to
        group by c.id) s), '[]'::jsonb),

    -- every restaurant / store × product (new products show up automatically)
    'sales_by_store_product', coalesce((select jsonb_agg(x order by x->>'customer', x->>'store' nulls first, (x->>'sort')::int) from (
        select jsonb_build_object('customer', c.name, 'type', c.type, 'store', cl.name,
                 'product', p.name_hu, 'product_id', p.id, 'sort', coalesce(p.sort, 0), 'unit', p.unit,
                 'qty', sum(coalesce(l.delivered_qty, l.qty)),
                 'value', sum(coalesce(l.delivered_qty, l.qty) * l.unit_price)) x
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
notify pgrst, 'reload schema';
