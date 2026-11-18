-- =====================================================================
-- 049 · 取消「客户需要打包」：改为每张订单在送货页点「备好了」记录
--   customers.needs_packing is not used; orders.packed_at / packed_by / packed_by_name stay and
--   now record who marked the order as "ready" and when (set_order_packed).
-- =====================================================================
alter table noodle.customers drop column if exists needs_packing;
comment on column noodle.orders.packed_at is 'when the order was marked as ready (goods prepared)';
notify pgrst, 'reload schema';
