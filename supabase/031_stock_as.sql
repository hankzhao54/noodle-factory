-- =====================================================================
-- 031 · 可互换的原料共用一份库存（例如食盐和海盐）
--   materials.stock_as = the material whose stock this one counts as. You still buy it under its
--   own name, pack size and price, but receiving it adds to the other material's stock, which is
--   the one recipes use. Such materials are left out of the stock list and shortage checks.
--   Set: Solinwest table salt 1 kg → counts as the sea salt (25 kg) used in the recipes.
--   The salt on labels is now just "só / salt / 盐" because either may be used.
-- =====================================================================
alter table noodle.materials add column if not exists stock_as uuid references noodle.materials(id) on delete set null;
alter table noodle.materials drop constraint if exists materials_stock_as_not_self;
alter table noodle.materials add constraint materials_stock_as_not_self check (stock_as is distinct from id);

-- no chains: the target must count as itself
create or replace function noodle.check_stock_as() returns trigger
language plpgsql set search_path = noodle, pg_temp as $$
begin
  if new.stock_as is not null and exists (select 1 from noodle.materials where id = new.stock_as and stock_as is not null) then
    raise exception 'stock_as target must not itself count as another material';
  end if;
  if new.stock_as is not null and exists (select 1 from noodle.materials where stock_as = new.id) then
    raise exception 'other materials already count as this one';
  end if;
  return new;
end $$;
drop trigger if exists materials_check_stock_as on noodle.materials;
create trigger materials_check_stock_as before insert or update of stock_as on noodle.materials
  for each row execute function noodle.check_stock_as();

create or replace function noodle.receive_purchase_order(p_po_id uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare l jsonb; pl noodle.purchase_order_lines; v_qty numeric; v_no bigint; v_lot text; v_stock uuid;
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
      select coalesce(stock_as, id) into v_stock from noodle.materials where id = pl.material_id;
      insert into noodle.stock_movements(material_id, qty, reason, ref_id, lot_no, expiry_date, note)
      values (v_stock, v_qty, 'purchase', p_po_id, v_lot, nullif(l->>'expiry_date','')::date,
              case when v_stock <> pl.material_id then (select name_hu from noodle.materials where id = pl.material_id) end);
      if pl.unit_price > 0 then
        update noodle.materials set cost_per_unit = pl.unit_price where id = pl.material_id;
      end if;
    end if;
  end loop;

  update noodle.purchase_orders set status = 'received', received_at = now() where id = p_po_id;
end $$;

create or replace view noodle.material_stock with (security_invoker = on) as
select m.id, m.code, m.name_zh, m.name_en, m.name_hu, m.category, m.unit,
       m.min_stock, m.cost_per_unit, m.default_supplier_id,
       coalesce(sum(s.qty), 0)::numeric(12,3) as on_hand,
       m.track_stock and coalesce(sum(s.qty), 0) < m.min_stock as below_min,
       m.track_stock
from noodle.materials m
left join noodle.stock_movements s on s.material_id = m.id
where m.active and m.stock_as is null
group by m.id;

-- Solinwest table salt counts as the recipe's sea salt; move what is already in stock over
update noodle.materials set stock_as = (select id from noodle.materials where code = 'BK-370000014331')
 where code = 'BK-202300000002';
update noodle.stock_movements set material_id = (select id from noodle.materials where code = 'BK-370000014331'),
       note = coalesce(note, 'Só asztali Solinwest 1 kg')
 where material_id = (select id from noodle.materials where code = 'BK-202300000002');
update noodle.materials set ingredient_hu = 'só', ingredient_en = 'salt', ingredient_zh = '盐'
 where code = 'BK-370000014331';

revoke execute on function noodle.check_stock_as() from public, anon, authenticated;
revoke execute on function noodle.receive_purchase_order(uuid, jsonb) from public, anon;
grant execute on function noodle.receive_purchase_order(uuid, jsonb) to authenticated;
grant select on noodle.material_stock to authenticated;
notify pgrst, 'reload schema';
