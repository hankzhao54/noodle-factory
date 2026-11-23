-- =====================================================================
-- 066 · 成本分析：每个人的效率 / Costs: efficiency per person
--   cost_report() also returns every finished batch (day, who finished it, kg), so the page can show
--   kg per labour hour per person (batches they finished ÷ their 101base hours) and per day.
--   Order #29 (samples for Hachi) moved to the sample account by hand on 2026-11-23.
-- =====================================================================
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
        from (select case when c.is_sample then 'sample' else c.type::text end k,
                     coalesce(l.delivered_qty, l.qty) q,
                     coalesce(l.delivered_qty, l.qty) * (l.unit_price + coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0)) v
              from noodle.orders o join noodle.customers c on c.id = o.customer_id join noodle.order_lines l on l.order_id = o.id
              where o.status = 'delivered' and o.delivery_date between p_from and p_to) d
        group by k) s)
  );
end $$;
revoke execute on function noodle.cost_report(date, date) from public, anon;
grant execute on function noodle.cost_report(date, date) to authenticated;
notify pgrst, 'reload schema';
