-- =====================================================================
-- 058 · 紧急订单不受截单时间 / 提前天数限制（今天也能下）；工厂休息日照样不行
-- =====================================================================
create or replace function noodle.place_order(p_delivery_date date, p_lines jsonb, p_notes text default null, p_customer_id uuid default null,
                                              p_location_id uuid default null, p_urgent boolean default false)
returns uuid language plpgsql security definer set search_path = noodle, pg_temp as $function$
declare v_cust uuid; v_loc uuid; v_order uuid; l jsonb; v_price numeric; v_min numeric; v_ok boolean; v_problem text;
        v_staff boolean := noodle.is_staff();
        v_internal boolean := noodle.my_role() = 'restaurant';
        v_urgent boolean := false;
        v_mode text := coalesce((select value from noodle.settings where key = 'urgent_orders'), 'all');
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

  v_loc := case when not v_staff and noodle.my_location_id() is not null then noodle.my_location_id() else p_location_id end;
  if v_loc is not null then
    if not exists (select 1 from noodle.customer_locations where id = v_loc and customer_id = v_cust and active) then
      raise exception 'store not available';
    end if;
  elsif exists (select 1 from noodle.customer_locations where customer_id = v_cust and active) then
    raise exception 'store required';
  end if;

  if p_delivery_date < (now() at time zone 'Europe/Budapest')::date then raise exception 'delivery date in the past'; end if;
  if v_staff then
    v_urgent := coalesce(p_urgent, false);
  else
    v_problem := noodle.delivery_date_problem(v_cust, p_delivery_date, v_loc);
    if coalesce(p_urgent, false) then
      if v_mode = 'off' or (v_mode = 'internal' and not v_internal) then raise exception 'urgent orders not available'; end if;
      -- urgent: delivery days, cut-off time and lead days do not apply; closed days still do
      if v_problem in ('no_delivery_day', 'not_your_day', 'too_late') then v_problem := ''; end if;
      v_urgent := true;
    end if;
    if v_problem <> '' then raise exception 'delivery date not allowed: %', v_problem; end if;
  end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'empty order'; end if;

  insert into noodle.orders(customer_id, location_id, delivery_date, notes, status, urgent)
  values (v_cust, v_loc, p_delivery_date, p_notes,
          case when v_staff or (v_internal and not v_urgent) then 'confirmed' else 'submitted' end, v_urgent)
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
end $function$;
