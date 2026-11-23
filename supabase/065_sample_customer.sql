-- =====================================================================
-- 065 · 样品账号 / Sample account
--   customers.is_sample: free samples given to guests and prospects. Orders for it take stock and print
--   delivery notes as usual, but count as samples (0 Ft) on the Costs page, not as restaurant use.
--   One such customer is created: "Minta / 样品" (internal, so no prices and no invoices).
-- =====================================================================
alter table noodle.customers add column if not exists is_sample boolean not null default false;

insert into noodle.customers (name, type, is_sample, delivery_notes, active)
select 'Minta / 样品', 'internal', true, 'Ingyenes minta – a címzettet a rendelés megjegyzésébe írd / 免费样品，收样品的人写在订单备注里', true
where not exists (select 1 from noodle.customers where is_sample);

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
