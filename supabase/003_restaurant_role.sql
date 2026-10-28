-- =====================================================================
-- 003 · 内部餐厅账号 (role = 'restaurant')
--   - only places orders for its own restaurant
--   - never sees prices (catalog returns null price)
--   - no minimum order quantity
--   - orders are confirmed immediately
-- Run once in Supabase → SQL Editor, after 001.
-- =====================================================================

alter table noodle.profiles drop constraint if exists profiles_role_check;
alter table noodle.profiles add constraint profiles_role_check
  check (role in ('admin','staff','customer','restaurant','pending'));

-- restaurant accounts are linked to a customer just like wholesale ones
create or replace function noodle.my_customer_id() returns uuid
language sql stable security definer set search_path = noodle, pg_temp as $$
  select customer_id from noodle.profiles
  where user_id = auth.uid() and role in ('customer','restaurant')
$$;

-- catalog: no price and no minimum for restaurant accounts
create or replace view noodle.my_catalog with (security_invoker = on) as
select p.id, p.code, p.name_zh, p.name_en, p.name_hu, p.description, p.unit,
       p.pack_size_g, p.shelf_life_days, p.storage,
       (case when noodle.my_role() = 'restaurant' then 0 else p.min_order_qty end)::numeric(12,3) as min_order_qty,
       p.sort,
       (case when noodle.my_role() = 'restaurant' then null
             else coalesce(cp.price, p.base_price) end)::numeric(12,2) as price
from noodle.products p
left join noodle.customer_prices cp
       on cp.product_id = p.id and cp.customer_id = noodle.my_customer_id()
where p.active and p.visible_to_customers;

-- place_order: restaurant accounts skip the minimum and are confirmed at once.
-- The internal price is still stored on the order line for cost tracking.
create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb,
                                              p_notes text default null, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_cust uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean;
        v_staff boolean := noodle.is_staff();
        v_internal boolean := noodle.my_role() = 'restaurant';
begin
  if v_staff then v_cust := p_customer_id; else v_cust := noodle.my_customer_id(); end if;
  if v_cust is null then raise exception 'no customer account'; end if;
  if not exists (select 1 from noodle.customers where id = v_cust and active) then
    raise exception 'customer inactive';
  end if;
  if p_delivery_date < current_date then raise exception 'delivery date in the past'; end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, delivery_date, notes, status)
  values (v_cust, p_delivery_date, p_notes,
          case when v_staff or v_internal then 'confirmed' else 'submitted' end)
  returning id into v_order;

  for l in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((l->>'qty')::numeric, 0) <= 0;
    select coalesce(cp.price, p.base_price), p.min_order_qty,
           p.active and (p.visible_to_customers or v_staff)
      into v_price, v_min, v_ok
    from noodle.products p
    left join noodle.customer_prices cp on cp.product_id = p.id and cp.customer_id = v_cust
    where p.id = (l->>'product_id')::uuid;
    if not coalesce(v_ok,false) then raise exception 'product not available'; end if;
    if not v_internal and (l->>'qty')::numeric < v_min then
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

grant select on noodle.my_catalog to authenticated;
grant execute on all functions in schema noodle to authenticated;
revoke execute on all functions in schema noodle from anon, public;

notify pgrst, 'reload schema';
