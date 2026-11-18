-- =====================================================================
-- 051 · 生产需求也算「已备好」的订单
--   Bug: production_demand only counted submitted / confirmed orders. Since 048 the "goods ready"
--   button moves confirmed orders to "ready", and their noodles are still in stock (stock is only
--   deducted on delivery) — so marking orders ready made shortages disappear from the plan.
--   Ready orders now count as demand like the others.
-- =====================================================================
create or replace view noodle.production_demand with (security_invoker = true) as
  select o.delivery_date, ol.product_id, sum(ol.qty)::numeric(12,3) as qty
    from noodle.order_lines ol
    join noodle.orders o on o.id = ol.order_id
   where o.status in ('submitted', 'confirmed', 'ready')
   group by o.delivery_date, ol.product_id;
notify pgrst, 'reload schema';
