-- =====================================================================
-- 023 · 一个账号给多个客户下单
--   profile_customers: every customer (and optional store) an ordering account may order for.
--   profiles.customer_id / location_id stay the *current* one, so all existing rules (RLS, prices,
--   order rules, place_order) keep working; switch_customer() changes the current one and sets the
--   role from the customer type (own restaurant → 'restaurant', external → 'customer').
-- =====================================================================

create table if not exists noodle.profile_customers (
  user_id     uuid not null references noodle.profiles(user_id) on delete cascade,
  customer_id uuid not null references noodle.customers(id) on delete cascade,
  location_id uuid references noodle.customer_locations(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, customer_id)
);

-- existing links
insert into noodle.profile_customers (user_id, customer_id, location_id)
select user_id, customer_id, location_id from noodle.profiles where customer_id is not null
on conflict do nothing;

-- keep the list in step when an admin links / changes the current customer or store on the Users page
create or replace function noodle.sync_profile_customers() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if new.customer_id is not null and new.role in ('customer', 'restaurant') then
    insert into noodle.profile_customers (user_id, customer_id, location_id)
    values (new.user_id, new.customer_id, new.location_id)
    on conflict (user_id, customer_id) do update set location_id = excluded.location_id;
  end if;
  return new;
end $$;
drop trigger if exists profiles_sync_customers on noodle.profiles;
create trigger profiles_sync_customers after insert or update of customer_id, location_id, role on noodle.profiles
  for each row execute function noodle.sync_profile_customers();

alter table noodle.profile_customers enable row level security;
drop policy if exists admin_all on noodle.profile_customers;
drop policy if exists own_read on noodle.profile_customers;
create policy admin_all on noodle.profile_customers for all to authenticated using (noodle.is_admin()) with check (noodle.is_admin());
create policy own_read on noodle.profile_customers for select to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on noodle.profile_customers to authenticated;

-- the customers this account can order for (for the switcher)
create or replace function noodle.my_customers() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type,
           'store', l.name, 'current', c.id = p.customer_id) order by c.type desc, c.name), '[]'::jsonb)
  from noodle.profile_customers pc
  join noodle.customers c on c.id = pc.customer_id and c.active
  join noodle.profiles p on p.user_id = pc.user_id
  left join noodle.customer_locations l on l.id = pc.location_id
  where pc.user_id = auth.uid() and p.role in ('customer', 'restaurant')
$$;

create or replace function noodle.switch_customer(p_customer uuid) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_link noodle.profile_customers; v_type text;
begin
  if noodle.my_role() not in ('customer', 'restaurant') then raise exception 'not allowed'; end if;
  select * into v_link from noodle.profile_customers where user_id = auth.uid() and customer_id = p_customer;
  if v_link.user_id is null then raise exception 'not allowed'; end if;
  select type into v_type from noodle.customers where id = p_customer and active;
  if v_type is null then raise exception 'customer inactive'; end if;
  update noodle.profiles
     set customer_id = p_customer, location_id = v_link.location_id,
         role = case when v_type = 'internal' then 'restaurant' else 'customer' end
   where user_id = auth.uid();
end $$;

-- order emails: everyone linked to the customer (and to that store, or to all its stores)
create or replace function noodle.order_email_payload(p_order uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v jsonb;
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  select jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'no', o.no, 'status', o.status, 'delivery_date', o.delivery_date,
                                'notes', o.notes, 'created_at', o.created_at),
    'customer', jsonb_build_object('id', c.id, 'name', c.name || coalesce(' · ' || lo.name, ''), 'type', c.type, 'email', c.email,
                                   'address', coalesce(nullif(lo.address, ''), c.address),
                                   'phone', coalesce(nullif(lo.phone, ''), c.phone),
                                   'contact_person', coalesce(nullif(lo.contact_person, ''), c.contact_person)),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                 'name_hu', p.name_hu, 'name_en', p.name_en, 'name_zh', p.name_zh, 'unit', p.unit,
                 'qty', l.qty, 'unit_price', l.unit_price) order by p.sort, p.name_hu)
               from noodle.order_lines l join noodle.products p on p.id = l.product_id
               where l.order_id = o.id), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', pr.lang))
               from noodle.profile_customers pc
               join noodle.profiles pr on pr.user_id = pc.user_id and pr.role in ('customer', 'restaurant')
               join auth.users u on u.id = pc.user_id
               where pc.customer_id = c.id
                 and (pc.location_id is null or pc.location_id is not distinct from o.location_id)), '[]'::jsonb),
    'sent', coalesce((select jsonb_agg(distinct kind) from noodle.email_log
               where order_id = o.id and status = 'sent'), '[]'::jsonb),
    'settings', (select jsonb_object_agg(key, value) from noodle.settings
               where key like 'email\_%' or key like 'slack\_%' or key = 'app_url'))
  into v
  from noodle.orders o join noodle.customers c on c.id = o.customer_id
  left join noodle.customer_locations lo on lo.id = o.location_id
  where o.id = p_order;
  return v;
end $$;

drop trigger if exists audit on noodle.profile_customers;
create trigger audit after insert or update or delete on noodle.profile_customers
  for each row execute function noodle.audit_trigger();

revoke execute on function noodle.sync_profile_customers() from public, anon, authenticated;
revoke execute on function noodle.my_customers() from public, anon;
revoke execute on function noodle.switch_customer(uuid) from public, anon;
revoke execute on function noodle.order_email_payload(uuid, text) from public, anon, authenticated;
grant execute on function noodle.my_customers() to authenticated;
grant execute on function noodle.switch_customer(uuid) to authenticated;
grant execute on function noodle.order_email_payload(uuid, text) to service_role;
notify pgrst, 'reload schema';
