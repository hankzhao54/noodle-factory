-- =====================================================================
-- 016 · 合规：公司信息、交易条款（ÁSZF）接受记录、产品信息（配料/过敏原）、
--       配料表名称、生产损耗
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Company data (Impresszum, terms, privacy notice, labels). Admins edit them in the back office.
-- ---------------------------------------------------------------------
insert into noodle.settings (key, value) values
  ('company_name', '101 Étterem Kft.'),
  ('company_address', '1118 Budapest, Késmárki utca 10. 2. emelet 13. ajtó'),
  ('company_reg_no', ''),                 -- cégjegyzékszám
  ('company_court', 'Fővárosi Törvényszék Cégbírósága'),
  ('company_tax_no', ''),                 -- adószám
  ('company_email', 'rendeles@101bistro.hu'),
  ('company_phone', ''),
  ('company_authority', ''),              -- food-chain supervisory authority / registration no. (optional)
  ('terms_version', '2026-11-07')         -- bump when the terms change: customers accept again
on conflict (key) do nothing;

-- the producer printed on labels = the company, unless already set
update noodle.settings set value = '101 Étterem Kft.' where key = 'label_producer' and coalesce(value, '') = '';
update noodle.settings set value = '1118 Budapest, Késmárki utca 10. 2/13.' where key = 'label_address' and coalesce(value, '') = '';
insert into noodle.settings (key, value) values ('label_producer', '101 Étterem Kft.'), ('label_address', '1118 Budapest, Késmárki utca 10. 2/13.')
on conflict (key) do nothing;

-- public, read-only: the legal pages are visible without signing in
create or replace function noodle.public_info() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from noodle.settings
  where key in ('company_name','company_address','company_reg_no','company_court','company_tax_no',
                'company_email','company_phone','company_authority','terms_version',
                'order_cutoff_time','order_lead_days')
$$;

-- ---------------------------------------------------------------------
-- B. Accepting the terms (external customers must accept the current version before ordering)
-- ---------------------------------------------------------------------
alter table noodle.profiles add column if not exists terms_version text;
alter table noodle.profiles add column if not exists terms_accepted_at timestamptz;

create or replace function noodle.accept_terms() returns text
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v text := (select value from noodle.settings where key = 'terms_version');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update noodle.profiles set terms_version = v, terms_accepted_at = now() where user_id = auth.uid();
  if not found then raise exception 'no profile'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- C. Ingredient-list names for raw materials (the purchasing name is not an ingredient name)
-- ---------------------------------------------------------------------
alter table noodle.materials add column if not exists ingredient_hu text;
alter table noodle.materials add column if not exists ingredient_en text;
alter table noodle.materials add column if not exists ingredient_zh text;

update noodle.materials m set ingredient_hu = x.hu, ingredient_en = x.en, ingredient_zh = x.zh
from (values
  ('BK-370000006907', 'búzaliszt (BL80)', 'wheat flour (BL80)', '小麦粉（BL80）'),
  ('BK-202410000069', 'búzaliszt (BL55)', 'wheat flour (BL55)', '小麦粉（BL55）'),
  ('BK-202410000071', 'rétesliszt (búza)', 'wheat flour', '小麦粉'),
  ('BK-202411000005', 'búzasikér', 'wheat gluten', '小麦谷朊粉'),
  ('BK-202411000002', 'búzakeményítő', 'wheat starch', '小麦淀粉'),
  ('BK-202411000001', 'burgonyakeményítő', 'potato starch', '马铃薯淀粉'),
  ('BK-202411000004', 'kukoricakeményítő', 'maize starch', '玉米淀粉'),
  ('BK-370000014331', 'tengeri só', 'sea salt', '海盐'),
  ('BK-202300000002', 'só', 'salt', '食盐'),
  ('BK-221900000026', 'savanyúságot szabályozó anyag (E500)', 'acidity regulator (E500)', '酸度调节剂（E500）'),
  ('M-E501I', 'savanyúságot szabályozó anyag (E501)', 'acidity regulator (E501)', '酸度调节剂（E501）'),
  ('M-E101', 'színezék (E101)', 'colour (E101)', '着色剂（E101）'),
  ('M-WATER', 'víz', 'water', '水')
) as x(code, hu, en, zh)
where m.code = x.code and m.ingredient_hu is null;

-- ---------------------------------------------------------------------
-- D. Product information before ordering / on delivery notes:
--    ingredients (heaviest first, allergens flagged), allergens, storage, shelf life, pack size, producer.
--    Customers get the products they can order; staff get all active products.
-- ---------------------------------------------------------------------
create or replace function noodle.product_info() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce(jsonb_object_agg(p.id, jsonb_build_object(
    'storage', p.storage,
    'shelf_life_days', p.shelf_life_days,
    'pack_size_g', p.pack_size_g,
    'label_qty_kg', p.label_qty_kg,
    'description', p.description,
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hu', coalesce(m.ingredient_hu, m.name_hu), 'en', coalesce(m.ingredient_en, m.name_en, m.name_hu),
               'zh', coalesce(m.ingredient_zh, m.name_zh, m.name_hu),
               'allergen', cardinality(coalesce(m.allergens, '{}')) > 0)
             order by rl.qty_per_batch * case m.unit when 'g' then 0.001 when 'ml' then 0.001 else 1 end desc)
      from noodle.recipe_lines rl join noodle.materials m on m.id = rl.material_id
      where rl.product_id = p.id and m.on_label), '[]'::jsonb),
    'allergens', coalesce((
      select jsonb_agg(distinct a) from noodle.recipe_lines rl
      join noodle.materials m on m.id = rl.material_id, unnest(coalesce(m.allergens, '{}')) a
      where rl.product_id = p.id and m.on_label), '[]'::jsonb))), '{}'::jsonb)
  from noodle.products p
  where p.active and (noodle.is_staff() or (p.visible_to_customers and noodle.my_customer_id() is not null))
$$;

-- ---------------------------------------------------------------------
-- E. Production loss: expected loss % per product; cost per kg uses the expected output
-- ---------------------------------------------------------------------
alter table noodle.products add column if not exists loss_pct numeric(5,2) default 0
  check (loss_pct >= 0 and loss_pct < 50);
alter table noodle.products alter column loss_pct drop not null;

create or replace view noodle.product_cost with (security_invoker = on) as
select p.id as product_id,
       coalesce(sum(rl.qty_per_batch * m.cost_per_unit), 0)::numeric(12,2) as batch_cost,
       (coalesce(sum(rl.qty_per_batch * m.cost_per_unit), 0)
         / nullif(p.batch_yield * (1 - coalesce(p.loss_pct, 0) / 100), 0))::numeric(12,2) as unit_cost,
       (p.batch_yield * (1 - coalesce(p.loss_pct, 0) / 100))::numeric(12,3) as expected_yield
from noodle.products p
left join noodle.recipe_lines rl on rl.product_id = p.id
left join noodle.materials m on m.id = rl.material_id
group by p.id;

-- ---------------------------------------------------------------------
-- F. place_order: same as 015, plus external customers must have accepted the current terms
-- ---------------------------------------------------------------------
create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb,
                                              p_notes text default null, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_cust uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean; v_problem text;
        v_staff boolean := noodle.is_staff();
        v_internal boolean := noodle.my_role() = 'restaurant';
begin
  if v_staff then v_cust := p_customer_id; else v_cust := noodle.my_customer_id(); end if;
  if v_cust is null then raise exception 'no customer account'; end if;
  if not exists (select 1 from noodle.customers where id = v_cust and active) then
    raise exception 'customer inactive';
  end if;
  if noodle.my_role() = 'customer' and (select terms_version from noodle.profiles where user_id = auth.uid())
       is distinct from (select value from noodle.settings where key = 'terms_version') then
    raise exception 'terms not accepted';
  end if;
  if p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if not v_staff then
    v_problem := noodle.delivery_date_problem(v_cust, p_delivery_date);
    if v_problem <> '' then raise exception 'delivery date not allowed: %', v_problem; end if;
  end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, delivery_date, notes, status)
  values (v_cust, p_delivery_date, p_notes,
          case when v_staff or v_internal then 'confirmed' else 'submitted' end)
  returning id into v_order;

  for l in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((l->>'qty')::numeric, 0) <= 0;
    select noodle.price_for(v_cust, p.id), p.min_order_qty,
           p.active and (p.visible_to_customers or v_staff)
      into v_price, v_min, v_ok
    from noodle.products p
    where p.id = (l->>'product_id')::uuid;
    if not coalesce(v_ok,false) then raise exception 'product not available'; end if;
    if not (v_internal or v_staff) and (l->>'qty')::numeric < v_min then
      raise exception 'below minimum order quantity';
    end if;
    insert into noodle.order_lines(order_id, product_id, qty, unit_price)
    values (v_order, (l->>'product_id')::uuid, (l->>'qty')::numeric, v_price);
  end loop;

  if not exists (select 1 from noodle.order_lines where order_id = v_order) then
    raise exception 'empty order';
  end if;
  return v_order;
end $$;

revoke execute on all functions in schema noodle from anon, public;
revoke execute on function noodle.price_for(uuid, uuid) from authenticated;
grant usage on schema noodle to anon;   -- only public_info() is executable for anon; no table grants
grant execute on function noodle.public_info() to anon, authenticated;
grant execute on function noodle.accept_terms() to authenticated;
grant execute on function noodle.product_info() to authenticated;
grant execute on function noodle.place_order(date, jsonb, text, uuid) to authenticated;

notify pgrst, 'reload schema';
