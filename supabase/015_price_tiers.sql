-- =====================================================================
-- 015 · 价格分档
--   price for a customer = customer's own price  >  price of the customer's tier  >  product base price
--   Tiers and tier prices: staff can read, only admins can change (same as customer prices).
--   Only admins can change which tier a customer is on (trigger below).
-- =====================================================================

create table if not exists noodle.price_tiers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists noodle.price_tier_prices (
  tier_id    uuid not null references noodle.price_tiers(id) on delete cascade,
  product_id uuid not null references noodle.products(id) on delete cascade,
  price      numeric(12,2) not null check (price >= 0),
  primary key (tier_id, product_id)
);

alter table noodle.customers add column if not exists price_tier_id uuid references noodle.price_tiers(id) on delete set null;

alter table noodle.price_tiers enable row level security;
alter table noodle.price_tier_prices enable row level security;
drop policy if exists staff_read on noodle.price_tiers;
drop policy if exists admin_write on noodle.price_tiers;
drop policy if exists staff_read on noodle.price_tier_prices;
drop policy if exists admin_write on noodle.price_tier_prices;
create policy staff_read on noodle.price_tiers for select to authenticated using (noodle.is_staff());
create policy admin_write on noodle.price_tiers for all to authenticated using (noodle.is_admin()) with check (noodle.is_admin());
create policy staff_read on noodle.price_tier_prices for select to authenticated using (noodle.is_staff());
create policy admin_write on noodle.price_tier_prices for all to authenticated using (noodle.is_admin()) with check (noodle.is_admin());
grant select, insert, update, delete on noodle.price_tiers, noodle.price_tier_prices to authenticated;

-- only admins may move a customer to another tier (staff can still edit the rest of the customer)
create or replace function noodle.guard_customer_tier() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if (tg_op = 'INSERT' and new.price_tier_id is not null)
     or (tg_op = 'UPDATE' and new.price_tier_id is distinct from old.price_tier_id) then
    if auth.uid() is not null and not noodle.is_admin() then
      raise exception 'only admins can change the price tier';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists customers_tier_guard on noodle.customers;
create trigger customers_tier_guard before insert or update on noodle.customers
  for each row execute function noodle.guard_customer_tier();

-- the one place the price is decided
create or replace function noodle.price_for(p_customer uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce(
    (select price from noodle.customer_prices where customer_id = p_customer and product_id = p_product),
    (select tp.price from noodle.price_tier_prices tp
       join noodle.customers c on c.price_tier_id = tp.tier_id
      where c.id = p_customer and tp.product_id = p_product),
    (select base_price from noodle.products where id = p_product))
$$;

-- the signed-in customer's own price (customers may only see their own)
create or replace function noodle.my_price(p_product uuid) returns numeric
language sql stable security definer set search_path = noodle, pg_temp as $$
  select noodle.price_for(noodle.my_customer_id(), p_product)
$$;

-- every product's price for one customer, with where it comes from (staff, or the customer itself)
create or replace function noodle.prices_for_customer(p_customer uuid)
returns table(product_id uuid, price numeric, source text)
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
begin
  if not (noodle.is_staff() or p_customer = noodle.my_customer_id()) then raise exception 'not allowed'; end if;
  return query
    select p.id,
           coalesce(cp.price, tp.price, p.base_price)::numeric,
           case when cp.price is not null then 'customer' when tp.price is not null then 'tier' else 'base' end
    from noodle.products p
    left join noodle.customer_prices cp on cp.product_id = p.id and cp.customer_id = p_customer
    left join noodle.customers c on c.id = p_customer
    left join noodle.price_tier_prices tp on tp.tier_id = c.price_tier_id and tp.product_id = p.id;
end $$;

-- the customer catalog uses the same rule
create or replace view noodle.my_catalog with (security_invoker = on) as
select p.id, p.code, p.name_zh, p.name_en, p.name_hu, p.description, p.unit,
       p.pack_size_g, p.shelf_life_days, p.storage,
       (case when noodle.my_role() = 'restaurant' then 0 else p.min_order_qty end)::numeric(12,3) as min_order_qty,
       p.sort,
       (case when noodle.my_role() = 'restaurant' then null
             else noodle.my_price(p.id) end)::numeric(12,2) as price,
       p.image_path
from noodle.products p
where p.active and p.visible_to_customers;
grant select on noodle.my_catalog to authenticated;

-- placing an order: same rules as 013, price from price_for()
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
grant execute on function noodle.my_price(uuid) to authenticated;
grant execute on function noodle.prices_for_customer(uuid) to authenticated;
grant execute on function noodle.place_order(date, jsonb, text, uuid) to authenticated;

notify pgrst, 'reload schema';
