-- =====================================================================
-- 028 · 不计库存的原料（比如水）
--   materials.track_stock = false: never "short" or "below minimum", not taken out of stock
--   when a batch is finished, not suggested for purchase. Water is set to untracked.
-- =====================================================================
alter table noodle.materials add column if not exists track_stock boolean not null default true;
update noodle.materials set track_stock = false where code = 'M-WATER';

create or replace view noodle.material_stock with (security_invoker = on) as
select m.id, m.code, m.name_zh, m.name_en, m.name_hu, m.category, m.unit,
       m.min_stock, m.cost_per_unit, m.default_supplier_id,
       coalesce(sum(s.qty), 0)::numeric(12,3) as on_hand,
       m.track_stock and coalesce(sum(s.qty), 0) < m.min_stock as below_min,
       m.track_stock
from noodle.materials m
left join noodle.stock_movements s on s.material_id = m.id
where m.active
group by m.id;

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

  for r in select rl.material_id, rl.qty_per_batch * b.batches as qty
           from noodle.recipe_lines rl join noodle.materials m on m.id = rl.material_id
           where rl.product_id = b.product_id and m.track_stock order by rl.sort loop
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

revoke execute on function noodle.complete_production(uuid, numeric, text) from public, anon;
grant execute on function noodle.complete_production(uuid, numeric, text) to authenticated;
grant select on noodle.material_stock to authenticated;
notify pgrst, 'reload schema';
