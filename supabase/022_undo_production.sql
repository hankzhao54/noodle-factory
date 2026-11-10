-- =====================================================================
-- 022 · 撤销「完成生产」（管理员）
--   Puts a finished batch back to planned: removes the materials it used and the noodles it added
--   to stock, clears the lot. Refused once anything else has touched that lot (delivered,
--   adjusted, written off), because then the stock history would no longer add up.
-- =====================================================================
create or replace function noodle.undo_production(p_batch_id uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare b noodle.production_batches;
begin
  if not noodle.is_admin() then raise exception 'admin only'; end if;
  select * into b from noodle.production_batches where id = p_batch_id for update;
  if b.id is null or b.status <> 'done' then raise exception 'batch not done'; end if;
  if b.lot_no is not null and exists (
       select 1 from noodle.stock_movements
        where lot_no = b.lot_no and product_id = b.product_id and coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid) <> b.id) then
    raise exception 'lot already used';
  end if;
  delete from noodle.stock_movements where ref_id = b.id and reason in ('production_use', 'production_out');
  update noodle.production_batches
     set status = 'planned', actual_qty = null, lot_no = null, done_at = null
   where id = b.id;
end $$;

revoke execute on function noodle.undo_production(uuid) from public, anon;
grant execute on function noodle.undo_production(uuid) to authenticated;
notify pgrst, 'reload schema';
