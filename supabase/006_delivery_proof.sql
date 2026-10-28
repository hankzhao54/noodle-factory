-- =====================================================================
-- 006 · 送达记录 + 签收照片
--   - per-order delivery: actual quantities, receiver name, photo proofs
--   - stock is deducted by the quantity actually delivered
--   - private storage bucket `noodle-delivery-proofs` (path: <order_id>/<file>)
-- =====================================================================

alter table noodle.orders
  add column if not exists delivered_at  timestamptz,
  add column if not exists delivered_by  uuid,
  add column if not exists received_by   text,
  add column if not exists proof_paths   text[] not null default '{}';

alter table noodle.order_lines
  add column if not exists delivered_qty numeric(12,3);

-- Deliver one order.
-- p_lines = [{"line_id":..,"qty":..}]  (omitted lines are delivered in full)
create or replace function noodle.deliver_order(p_order_id uuid, p_lines jsonb default '[]',
                                                p_received_by text default null,
                                                p_proofs text[] default '{}')
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders; l noodle.order_lines; v_qty numeric; v_given jsonb;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order_id for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status not in ('submitted','confirmed','ready') then raise exception 'order already delivered or cancelled'; end if;

  for l in select * from noodle.order_lines where order_id = o.id loop
    select x into v_given from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) x
      where x->>'line_id' = l.id::text limit 1;
    v_qty := coalesce((v_given->>'qty')::numeric, l.qty);
    if v_qty < 0 then raise exception 'invalid quantity'; end if;
    update noodle.order_lines set delivered_qty = v_qty where id = l.id;
    if v_qty > 0 then
      insert into noodle.stock_movements(product_id, qty, reason, ref_id, note)
      values (l.product_id, -v_qty, 'delivery', o.id, 'order #' || o.no);
    end if;
  end loop;

  update noodle.orders
     set status = 'delivered', delivered_at = now(), delivered_by = auth.uid(),
         received_by = nullif(p_received_by, ''),
         proof_paths = coalesce(p_proofs, '{}')
   where id = o.id;

  -- close the run when every order on it is delivered/cancelled
  if o.delivery_id is not null and not exists (
       select 1 from noodle.orders where delivery_id = o.delivery_id
       and status in ('submitted','confirmed','ready')) then
    update noodle.deliveries set status = 'done', done_at = now() where id = o.delivery_id;
  end if;
end $$;

-- add photos to an already delivered order (e.g. uploaded later)
create or replace function noodle.add_delivery_proofs(p_order_id uuid, p_proofs text[])
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  update noodle.orders set proof_paths = proof_paths || coalesce(p_proofs, '{}') where id = p_order_id;
end $$;

-- whole run: deliver every remaining order in full (kept for "mark all delivered")
create or replace function noodle.complete_delivery(p_delivery_id uuid)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
declare oid uuid;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  for oid in select id from noodle.orders where delivery_id = p_delivery_id
             and status in ('submitted','confirmed','ready') loop
    perform noodle.deliver_order(oid);
  end loop;
  update noodle.deliveries set status = 'done', done_at = coalesce(done_at, now()) where id = p_delivery_id;
end $$;

-- staff placing an order for a customer are not bound by the minimum order quantity
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

grant execute on all functions in schema noodle to authenticated;
revoke execute on all functions in schema noodle from anon, public;
