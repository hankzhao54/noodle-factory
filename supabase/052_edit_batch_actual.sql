-- =====================================================================
-- 052 · 生产完成后可以改实际产量（忘了称重直接入库时，事后补称）
--   set_batch_actual(batch, qty): staff only, finished batches only. Changes the batch's actual
--   quantity and its stock entry (same lot / expiry); materials used are not touched (the number of
--   batches stays the same). Logged in the audit log like every change.
-- =====================================================================
create or replace function noodle.set_batch_actual(p_batch uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare b noodle.production_batches; v_exp date; v_mv uuid;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'invalid quantity'; end if;
  select * into b from noodle.production_batches where id = p_batch for update;
  if b.id is null or b.status <> 'done' then raise exception 'batch not finished'; end if;
  if b.actual_qty = p_qty then return; end if;

  select id into v_mv from noodle.stock_movements where ref_id = b.id and reason = 'production_out' and product_id = b.product_id limit 1;
  if v_mv is not null then
    if p_qty > 0 then update noodle.stock_movements set qty = p_qty where id = v_mv;
    else delete from noodle.stock_movements where id = v_mv; end if;
  elsif p_qty > 0 then
    select (b.done_at at time zone 'Europe/Budapest')::date + shelf_life_days into v_exp from noodle.products where id = b.product_id;
    insert into noodle.stock_movements (product_id, qty, reason, ref_id, lot_no, expiry_date)
    values (b.product_id, p_qty, 'production_out', b.id, b.lot_no, v_exp);
  end if;
  update noodle.production_batches set actual_qty = p_qty where id = b.id;
end $$;
revoke execute on function noodle.set_batch_actual(uuid, numeric) from public, anon;
grant execute on function noodle.set_batch_actual(uuid, numeric) to authenticated;
notify pgrst, 'reload schema';
