-- =====================================================================
-- 062 · 真空袋库存：送货时按打包方式自动扣袋子
--   Each customer (restaurant) has its own fixed bag rule, set once:
--     customers.portions_per_bag — portions in one vacuum bag (e.g. 16 × 140 g); empty = setting packing_portions_per_bag (16)
--     customers.bag_kg           — kg in one vacuum bag when not portioned; empty = setting packing_bag_kg (2.5)
--   Material "Vákuumzsák (nagy)" (pieces) is created and linked in setting packing_bag_material.
--   When an order is delivered, the bags of its vacuum-packed lines are taken out of stock
--   (stock_movements, reason production_use, ref_id = order, note 'Csomagolás #no'); recalculated if the
--   delivery changes, removed if the order is no longer delivered. Stocktakes correct any difference.
--     portions + vacuum: ceil(ceil(kg × 1000 / portion g) / portions per bag)
--     vacuum only:       ceil(kg / kg per bag)
-- =====================================================================
alter table noodle.customers add column if not exists portions_per_bag integer check (portions_per_bag is null or portions_per_bag between 1 and 1000);
alter table noodle.customers add column if not exists bag_kg numeric(6,2) check (bag_kg is null or bag_kg > 0);

insert into noodle.settings (key, value) values
  ('packing_portions_per_bag', '16'),
  ('packing_bag_kg', '2.5')
on conflict (key) do nothing;

do $$
declare v uuid;
begin
  if not exists (select 1 from noodle.settings where key = 'packing_bag_material' and nullif(value, '') is not null) then
    insert into noodle.materials (code, name_zh, name_en, name_hu, category, unit, on_label, track_stock)
    values ('PACK-VAC-L', '大真空袋', 'Vacuum bag (large)', 'Vákuumzsák (nagy)', '包装', 'db', false, true)
    returning id into v;
    insert into noodle.settings (key, value) values ('packing_bag_material', v::text)
    on conflict (key) do update set value = excluded.value;
  end if;
end $$;

-- bags one line needs (0 when not vacuum packed)
create or replace function noodle.line_bags(l noodle.order_lines, c noodle.customers) returns integer
language sql stable security definer set search_path = noodle, pg_temp as $$
  select case
    when not coalesce(l.pack_vacuum, false) then 0
    when l.portion_g is not null and l.portion_g > 0 then
      ceil(ceil(coalesce(l.delivered_qty, l.qty) * 1000 / l.portion_g)
           / greatest(coalesce(c.portions_per_bag, nullif((select value from noodle.settings where key = 'packing_portions_per_bag'), '')::int, 16), 1))::int
    else
      ceil(coalesce(l.delivered_qty, l.qty)
           / greatest(coalesce(c.bag_kg, nullif((select value from noodle.settings where key = 'packing_bag_kg'), '')::numeric, 2.5), 0.1))::int
  end
$$;
revoke execute on function noodle.line_bags(noodle.order_lines, noodle.customers) from public, anon;
grant execute on function noodle.line_bags(noodle.order_lines, noodle.customers) to authenticated;

-- bags per order (shown on the delivery page)
create or replace function noodle.order_bags(p_order uuid) returns integer
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce(sum(noodle.line_bags(l, c)), 0)::int
  from noodle.order_lines l join noodle.orders o on o.id = l.order_id join noodle.customers c on c.id = o.customer_id
  where l.order_id = p_order
$$;
revoke execute on function noodle.order_bags(uuid) from public, anon;
grant execute on function noodle.order_bags(uuid) to authenticated;

-- runs at the end of the transaction, so delivered quantities written after the status are included
create or replace function noodle.sync_packing_bags() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; v_mat uuid; v_bags int;
begin
  select * into o from noodle.orders where id = new.id;
  v_mat := nullif((select value from noodle.settings where key = 'packing_bag_material'), '')::uuid;
  if o.id is null or v_mat is null then return null; end if;
  delete from noodle.stock_movements where ref_id = o.id and material_id = v_mat and note like 'Csomagolás%';
  if o.status = 'delivered' then
    v_bags := noodle.order_bags(o.id);
    if v_bags > 0 then
      insert into noodle.stock_movements (material_id, qty, reason, ref_id, note)
      values (v_mat, -v_bags, 'production_use', o.id, 'Csomagolás #' || o.no);
    end if;
  end if;
  return null;
end $$;
revoke execute on function noodle.sync_packing_bags() from public, anon, authenticated;
drop trigger if exists packing_bags on noodle.orders;
create constraint trigger packing_bags after update on noodle.orders
  deferrable initially deferred for each row
  when (old.status is distinct from new.status and (old.status = 'delivered' or new.status = 'delivered'))
  execute function noodle.sync_packing_bags();

-- the delivery page shows bags per line
create or replace function noodle.public_info() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $function$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from noodle.settings
  where key in ('company_name','company_address','company_reg_no','company_court','company_tax_no',
                'company_email','company_phone','company_authority','terms_version',
                'order_cutoff_time','order_lead_days',
                'packing_vacuum_fee','packing_portion_fee','packing_bag_text','packing_portions_per_bag','packing_bag_kg')
$function$;

notify pgrst, 'reload schema';
