-- =====================================================================
-- 面条工厂后台 · Noodle Factory · Tésztaüzem
-- Supabase migration 001 — creates everything under schema `noodle`.
-- Safe to run in the shared Supabase instance: it does not touch
-- `public`, `ordering`, `sales` or any other existing schema,
-- and it adds no triggers on auth.users.
--
-- Run once in Supabase → SQL Editor.  Afterwards:
--   Settings → API → Exposed schemas → add `noodle`
-- =====================================================================

create schema if not exists noodle;

-- ---------------------------------------------------------------------
-- Users & roles
--   admin    : everything, incl. user management and prices
--   staff    : factory work (purchasing, stock, production, delivery)
--   customer : external / restaurant ordering portal, own data only
--   pending  : signed up, waiting for admin approval
-- A user only gets a noodle profile when they request access from this
-- app, so users of the other apps on this Supabase are unaffected.
-- ---------------------------------------------------------------------
create table noodle.customers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  type                text not null default 'wholesale'
                        check (type in ('internal','wholesale')),
  contact_person      text,
  phone               text,
  email               text,
  address             text,
  delivery_notes      text,
  vat_no              text,
  ramen_lead_place_id text,   -- soft link to sales.ramen_leads.google_place_id
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

create table noodle.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'pending'
                 check (role in ('admin','staff','customer','pending')),
  customer_id  uuid references noodle.customers(id) on delete set null,
  display_name text,
  company      text,        -- what the person typed when requesting access
  phone        text,
  lang         text not null default 'zh' check (lang in ('zh','en','hu')),
  created_at   timestamptz not null default now()
);

create or replace function noodle.my_role() returns text
language sql stable security definer set search_path = noodle, pg_temp as $$
  select role from noodle.profiles where user_id = auth.uid()
$$;

create or replace function noodle.is_staff() returns boolean
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce((select role in ('admin','staff') from noodle.profiles
                   where user_id = auth.uid()), false)
$$;

create or replace function noodle.is_admin() returns boolean
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce((select role = 'admin' from noodle.profiles
                   where user_id = auth.uid()), false)
$$;

create or replace function noodle.my_customer_id() returns uuid
language sql stable security definer set search_path = noodle, pg_temp as $$
  select customer_id from noodle.profiles
  where user_id = auth.uid() and role = 'customer'
$$;

-- Called by a signed-in user who has no profile yet.
create or replace function noodle.request_access(p_name text, p_company text, p_phone text, p_lang text default 'zh')
returns noodle.profiles
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare r noodle.profiles;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into noodle.profiles(user_id, display_name, company, phone, lang)
  values (auth.uid(), p_name, p_company, p_phone, coalesce(p_lang,'zh'))
  on conflict (user_id) do update
     set display_name = excluded.display_name,
         company      = excluded.company,
         phone        = excluded.phone
     where noodle.profiles.role = 'pending'
  returning * into r;
  if r.user_id is null then select * into r from noodle.profiles where user_id = auth.uid(); end if;
  return r;
end $$;

-- Admin view of users (joins email from auth.users, which the client can't read).
create or replace function noodle.list_users()
returns table(user_id uuid, email text, role text, customer_id uuid, display_name text,
              company text, phone text, created_at timestamptz)
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
begin
  if not noodle.is_admin() then raise exception 'admin only'; end if;
  return query
    select p.user_id, u.email::text, p.role, p.customer_id, p.display_name,
           p.company, p.phone, p.created_at
    from noodle.profiles p join auth.users u on u.id = p.user_id
    order by (p.role = 'pending') desc, p.created_at desc;
end $$;

-- ---------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------
create table noodle.suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    text,
  phone      text,
  email      text,
  address    text,
  notes      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table noodle.materials (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique,
  name_zh             text not null,
  name_en             text,
  name_hu             text,
  category            text,                  -- 面粉 / 碱水 / 鸡蛋 / 包装 ...
  unit                text not null default 'kg',
  cost_per_unit       numeric(12,2) not null default 0,  -- HUF, updated on receipt
  min_stock           numeric(12,3) not null default 0,
  default_supplier_id uuid references noodle.suppliers(id) on delete set null,
  allergens           text[] not null default '{}',
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

create table noodle.products (
  id              uuid primary key default gen_random_uuid(),
  code            text unique,
  name_zh         text not null,
  name_en         text,
  name_hu         text,
  description     text,
  unit            text not null default 'kg',     -- selling / stock unit
  pack_size_g     integer,                        -- e.g. 150 g per portion
  shelf_life_days integer,
  storage         text,                           -- 冷藏 0-4°C / 冷冻 ...
  batch_yield     numeric(12,3) not null default 1, -- product units one recipe batch makes
  base_price      numeric(12,2) not null default 0, -- HUF per unit, default list price
  min_order_qty   numeric(12,3) not null default 0,
  visible_to_customers boolean not null default true,
  active          boolean not null default true,
  sort            integer not null default 0,
  created_at      timestamptz not null default now()
);

-- Recipe / BOM: raw material quantity for ONE batch of the product.
create table noodle.recipe_lines (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references noodle.products(id) on delete cascade,
  material_id   uuid not null references noodle.materials(id) on delete restrict,
  qty_per_batch numeric(12,4) not null check (qty_per_batch > 0),
  note          text,
  sort          integer not null default 0,
  unique (product_id, material_id)
);

-- Per-customer price; falls back to products.base_price.
create table noodle.customer_prices (
  customer_id uuid not null references noodle.customers(id) on delete cascade,
  product_id  uuid not null references noodle.products(id) on delete cascade,
  price       numeric(12,2) not null check (price >= 0),
  primary key (customer_id, product_id)
);

-- ---------------------------------------------------------------------
-- Purchasing
-- ---------------------------------------------------------------------
create table noodle.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  no            bigint generated always as identity,
  supplier_id   uuid not null references noodle.suppliers(id),
  status        text not null default 'draft'
                  check (status in ('draft','ordered','received','cancelled')),
  order_date    date not null default current_date,
  expected_date date,
  received_at   timestamptz,
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

create table noodle.purchase_order_lines (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references noodle.purchase_orders(id) on delete cascade,
  material_id  uuid not null references noodle.materials(id),
  qty          numeric(12,3) not null check (qty > 0),
  unit_price   numeric(12,2) not null default 0,
  received_qty numeric(12,3),
  lot_no       text,
  expiry_date  date
);

-- ---------------------------------------------------------------------
-- Inventory ledger: every change in stock is one row. Stock = sum(qty).
-- ---------------------------------------------------------------------
create table noodle.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  material_id uuid references noodle.materials(id),
  product_id  uuid references noodle.products(id),
  qty         numeric(12,3) not null,   -- + in / - out
  reason      text not null check (reason in
                ('purchase','production_use','production_out','delivery','adjust','waste','count')),
  ref_id      uuid,                     -- PO / batch / delivery id
  lot_no      text,
  expiry_date date,
  note        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  check ((material_id is null) <> (product_id is null))
);
create index on noodle.stock_movements(material_id);
create index on noodle.stock_movements(product_id);
create index on noodle.stock_movements(created_at desc);

-- ---------------------------------------------------------------------
-- Customer orders & deliveries
-- ---------------------------------------------------------------------
create table noodle.deliveries (
  id            uuid primary key default gen_random_uuid(),
  no            bigint generated always as identity,
  delivery_date date not null default current_date,
  driver        text,
  vehicle       text,
  status        text not null default 'planned' check (status in ('planned','out','done')),
  notes         text,
  done_at       timestamptz,
  created_at    timestamptz not null default now()
);

create table noodle.orders (
  id            uuid primary key default gen_random_uuid(),
  no            bigint generated always as identity,
  customer_id   uuid not null references noodle.customers(id),
  status        text not null default 'submitted' check (status in
                  ('submitted','confirmed','ready','delivered','cancelled')),
  delivery_date date not null,
  delivery_id   uuid references noodle.deliveries(id) on delete set null,
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
create index on noodle.orders(delivery_date);
create index on noodle.orders(customer_id);

create table noodle.order_lines (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references noodle.orders(id) on delete cascade,
  product_id uuid not null references noodle.products(id),
  qty        numeric(12,3) not null check (qty > 0),
  unit_price numeric(12,2) not null default 0
);

-- ---------------------------------------------------------------------
-- Production
-- ---------------------------------------------------------------------
create table noodle.production_batches (
  id           uuid primary key default gen_random_uuid(),
  no           bigint generated always as identity,
  product_id   uuid not null references noodle.products(id),
  planned_date date not null default current_date,
  batches      numeric(10,3) not null default 1 check (batches > 0), -- recipe multiplier
  actual_qty   numeric(12,3),
  status       text not null default 'planned' check (status in ('planned','done','cancelled')),
  lot_no       text,
  notes        text,
  done_at      timestamptz,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Views (security_invoker so RLS of the caller applies)
-- ---------------------------------------------------------------------
create view noodle.material_stock with (security_invoker = on) as
select m.id, m.code, m.name_zh, m.name_en, m.name_hu, m.category, m.unit,
       m.min_stock, m.cost_per_unit, m.default_supplier_id,
       coalesce(sum(s.qty), 0)::numeric(12,3) as on_hand,
       coalesce(sum(s.qty), 0) < m.min_stock as below_min
from noodle.materials m
left join noodle.stock_movements s on s.material_id = m.id
where m.active
group by m.id;

create view noodle.product_stock with (security_invoker = on) as
select p.id, p.code, p.name_zh, p.name_en, p.name_hu, p.unit,
       coalesce(sum(s.qty), 0)::numeric(12,3) as on_hand,
       coalesce((select sum(ol.qty) from noodle.order_lines ol
                 join noodle.orders o on o.id = ol.order_id
                 where ol.product_id = p.id and o.status in ('submitted','confirmed','ready')), 0
               )::numeric(12,3) as reserved
from noodle.products p
left join noodle.stock_movements s on s.product_id = p.id
where p.active
group by p.id;

-- Recipe cost per product unit
create view noodle.product_cost with (security_invoker = on) as
select p.id as product_id,
       coalesce(sum(rl.qty_per_batch * m.cost_per_unit), 0)::numeric(12,2) as batch_cost,
       (coalesce(sum(rl.qty_per_batch * m.cost_per_unit), 0) / nullif(p.batch_yield, 0))::numeric(12,2) as unit_cost
from noodle.products p
left join noodle.recipe_lines rl on rl.product_id = p.id
left join noodle.materials m on m.id = rl.material_id
group by p.id;

-- What needs producing: open order demand per product and delivery date
create view noodle.production_demand with (security_invoker = on) as
select o.delivery_date, ol.product_id, sum(ol.qty)::numeric(12,3) as qty
from noodle.order_lines ol
join noodle.orders o on o.id = ol.order_id
where o.status in ('submitted','confirmed')
group by o.delivery_date, ol.product_id;

-- Catalog as seen by the signed-in customer (own price or base price)
create view noodle.my_catalog with (security_invoker = on) as
select p.id, p.code, p.name_zh, p.name_en, p.name_hu, p.description, p.unit,
       p.pack_size_g, p.shelf_life_days, p.storage, p.min_order_qty, p.sort,
       coalesce(cp.price, p.base_price) as price
from noodle.products p
left join noodle.customer_prices cp
       on cp.product_id = p.id and cp.customer_id = noodle.my_customer_id()
where p.active and p.visible_to_customers;

-- ---------------------------------------------------------------------
-- Business operations (atomic, server-side)
-- ---------------------------------------------------------------------

-- Receive a PO: p_lines = [{"line_id":..,"received_qty":..,"lot_no":..,"expiry_date":"YYYY-MM-DD"}]
create or replace function noodle.receive_purchase_order(p_po_id uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare l jsonb; pl noodle.purchase_order_lines; v_qty numeric;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  perform 1 from noodle.purchase_orders where id = p_po_id and status in ('draft','ordered') for update;
  if not found then raise exception 'purchase order not open'; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    select * into pl from noodle.purchase_order_lines
      where id = (l->>'line_id')::uuid and po_id = p_po_id;
    if pl.id is null then raise exception 'line % not in PO', l->>'line_id'; end if;
    v_qty := coalesce((l->>'received_qty')::numeric, pl.qty);
    update noodle.purchase_order_lines
       set received_qty = v_qty,
           lot_no       = nullif(l->>'lot_no',''),
           expiry_date  = nullif(l->>'expiry_date','')::date
     where id = pl.id;
    if v_qty > 0 then
      insert into noodle.stock_movements(material_id, qty, reason, ref_id, lot_no, expiry_date)
      values (pl.material_id, v_qty, 'purchase', p_po_id,
              nullif(l->>'lot_no',''), nullif(l->>'expiry_date','')::date);
      if pl.unit_price > 0 then
        update noodle.materials set cost_per_unit = pl.unit_price where id = pl.material_id;
      end if;
    end if;
  end loop;

  update noodle.purchase_orders set status = 'received', received_at = now() where id = p_po_id;
end $$;

-- Finish a production batch: consumes recipe × batches, adds actual_qty of product.
create or replace function noodle.complete_production(p_batch_id uuid, p_actual_qty numeric, p_lot_no text default null)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare b noodle.production_batches; v_lot text; v_exp date;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into b from noodle.production_batches where id = p_batch_id for update;
  if b.id is null or b.status <> 'planned' then raise exception 'batch not open'; end if;
  if p_actual_qty is null or p_actual_qty < 0 then raise exception 'invalid quantity'; end if;

  v_lot := coalesce(nullif(p_lot_no,''), to_char(now(),'YYMMDD') || '-' || b.no);
  select current_date + shelf_life_days into v_exp from noodle.products where id = b.product_id;

  insert into noodle.stock_movements(material_id, qty, reason, ref_id, lot_no)
  select rl.material_id, -(rl.qty_per_batch * b.batches), 'production_use', b.id, v_lot
  from noodle.recipe_lines rl where rl.product_id = b.product_id;

  if p_actual_qty > 0 then
    insert into noodle.stock_movements(product_id, qty, reason, ref_id, lot_no, expiry_date)
    values (b.product_id, p_actual_qty, 'production_out', b.id, v_lot, v_exp);
  end if;

  update noodle.production_batches
     set status = 'done', actual_qty = p_actual_qty, lot_no = v_lot, done_at = now()
   where id = b.id;
end $$;

-- Mark a delivery done: all its orders become delivered and stock goes out.
create or replace function noodle.complete_delivery(p_delivery_id uuid)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  perform 1 from noodle.deliveries where id = p_delivery_id and status <> 'done' for update;
  if not found then raise exception 'delivery already done or missing'; end if;

  insert into noodle.stock_movements(product_id, qty, reason, ref_id, note)
  select ol.product_id, -ol.qty, 'delivery', p_delivery_id, 'order #' || o.no
  from noodle.orders o join noodle.order_lines ol on ol.order_id = o.id
  where o.delivery_id = p_delivery_id and o.status in ('submitted','confirmed','ready');

  update noodle.orders set status = 'delivered'
   where delivery_id = p_delivery_id and status in ('submitted','confirmed','ready');
  update noodle.deliveries set status = 'done', done_at = now() where id = p_delivery_id;
end $$;

-- Place an order. Customers order for themselves; staff pass p_customer_id.
-- Prices are always taken from the server, never from the client.
-- p_lines = [{"product_id":..,"qty":..}]
create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb,
                                              p_notes text default null, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_cust uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean;
begin
  if noodle.is_staff() then
    v_cust := p_customer_id;
  else
    v_cust := noodle.my_customer_id();
  end if;
  if v_cust is null then raise exception 'no customer account'; end if;
  if not exists (select 1 from noodle.customers where id = v_cust and active) then
    raise exception 'customer inactive';
  end if;
  if p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, delivery_date, notes, status)
  values (v_cust, p_delivery_date, p_notes, case when noodle.is_staff() then 'confirmed' else 'submitted' end)
  returning id into v_order;

  for l in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((l->>'qty')::numeric, 0) <= 0;
    select coalesce(cp.price, p.base_price), p.min_order_qty,
           p.active and (p.visible_to_customers or noodle.is_staff())
      into v_price, v_min, v_ok
    from noodle.products p
    left join noodle.customer_prices cp on cp.product_id = p.id and cp.customer_id = v_cust
    where p.id = (l->>'product_id')::uuid;
    if not coalesce(v_ok,false) then raise exception 'product not available'; end if;
    if (l->>'qty')::numeric < v_min then raise exception 'below minimum order quantity'; end if;
    insert into noodle.order_lines(order_id, product_id, qty, unit_price)
    values (v_order, (l->>'product_id')::uuid, (l->>'qty')::numeric, v_price);
  end loop;

  if not exists (select 1 from noodle.order_lines where order_id = v_order) then
    raise exception 'empty order';
  end if;
  return v_order;
end $$;

-- Customer may cancel own order while still 'submitted'.
create or replace function noodle.cancel_my_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  update noodle.orders set status = 'cancelled'
   where id = p_order_id and status = 'submitted'
     and (customer_id = noodle.my_customer_id() or noodle.is_staff());
  if not found then raise exception 'order can no longer be cancelled'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table noodle.customers            enable row level security;
alter table noodle.profiles             enable row level security;
alter table noodle.suppliers            enable row level security;
alter table noodle.materials            enable row level security;
alter table noodle.products             enable row level security;
alter table noodle.recipe_lines         enable row level security;
alter table noodle.customer_prices      enable row level security;
alter table noodle.purchase_orders      enable row level security;
alter table noodle.purchase_order_lines enable row level security;
alter table noodle.stock_movements      enable row level security;
alter table noodle.deliveries           enable row level security;
alter table noodle.orders               enable row level security;
alter table noodle.order_lines          enable row level security;
alter table noodle.production_batches   enable row level security;

-- staff: full access to factory tables
do $$
declare t text;
begin
  foreach t in array array['suppliers','materials','recipe_lines','purchase_orders',
                           'purchase_order_lines','stock_movements','deliveries',
                           'production_batches','customers','orders','order_lines','products']
  loop
    execute format('create policy staff_all on noodle.%I for all to authenticated
                    using (noodle.is_staff()) with check (noodle.is_staff())', t);
  end loop;
end $$;

-- prices: staff read, admin write
create policy staff_read on noodle.customer_prices for select to authenticated using (noodle.is_staff());
create policy admin_write on noodle.customer_prices for all to authenticated
  using (noodle.is_admin()) with check (noodle.is_admin());

-- customers: see only their own stuff
create policy cust_self on noodle.customers for select to authenticated
  using (id = noodle.my_customer_id());
create policy cust_products on noodle.products for select to authenticated
  using (active and visible_to_customers and noodle.my_customer_id() is not null);
create policy cust_prices on noodle.customer_prices for select to authenticated
  using (customer_id = noodle.my_customer_id());
create policy cust_orders on noodle.orders for select to authenticated
  using (customer_id = noodle.my_customer_id());
create policy cust_order_lines on noodle.order_lines for select to authenticated
  using (exists (select 1 from noodle.orders o where o.id = order_id
                 and o.customer_id = noodle.my_customer_id()));

-- profiles: everyone reads own; admin reads/updates all
create policy own_profile on noodle.profiles for select to authenticated
  using (user_id = auth.uid() or noodle.is_admin());
create policy admin_update on noodle.profiles for update to authenticated
  using (noodle.is_admin()) with check (noodle.is_admin());
create or replace function noodle.set_my_lang(p_lang text)
returns void language sql security definer set search_path = noodle, pg_temp as $$
  update noodle.profiles set lang = p_lang
  where user_id = auth.uid() and p_lang in ('zh','en','hu')
$$;

-- ---------------------------------------------------------------------
-- Grants (RLS still decides which rows)
-- ---------------------------------------------------------------------
grant usage on schema noodle to authenticated, anon;
grant select, insert, update, delete on all tables in schema noodle to authenticated;
grant usage, select on all sequences in schema noodle to authenticated;
grant execute on all functions in schema noodle to authenticated;
revoke execute on all functions in schema noodle from anon, public;

-- ---------------------------------------------------------------------
-- First admin: sign up once in the app, then run (with your email):
--   update noodle.profiles set role = 'admin'
--   where user_id = (select id from auth.users where email = 'YOUR_EMAIL');
-- ---------------------------------------------------------------------
