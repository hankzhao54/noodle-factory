-- =====================================================================
-- 059 · 外部客户自己维护公司信息（开票用）和门店信息
--   update_my_company: company name, billing address, tax number, contact, phone, e-mail, delivery
--   notes — only external customers (role customer) with a company-wide account.
--   update_my_store: a store's address, contact, phone and delivery notes — company-wide accounts for
--   any of their stores, store accounts for their own store. Changes go to the audit log.
-- =====================================================================
create or replace function noodle.update_my_company(p_name text, p_address text, p_vat_no text, p_contact text,
                                                    p_phone text, p_email text, p_notes text)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if noodle.my_role() <> 'customer' or noodle.my_customer_id() is null then raise exception 'not allowed'; end if;
  if noodle.my_location_id() is not null then raise exception 'store accounts cannot change company details'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'company name required'; end if;
  update noodle.customers set
    name = left(trim(p_name), 200),
    address = nullif(left(trim(coalesce(p_address, '')), 500), ''),
    vat_no = nullif(left(trim(coalesce(p_vat_no, '')), 40), ''),
    contact_person = nullif(left(trim(coalesce(p_contact, '')), 200), ''),
    phone = nullif(left(trim(coalesce(p_phone, '')), 60), ''),
    email = nullif(left(trim(coalesce(p_email, '')), 200), ''),
    delivery_notes = nullif(left(trim(coalesce(p_notes, '')), 1000), '')
  where id = noodle.my_customer_id() and type <> 'internal';
  if not found then raise exception 'not allowed'; end if;
end $$;

create or replace function noodle.update_my_store(p_store uuid, p_address text, p_contact text, p_phone text, p_notes text)
returns void language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if noodle.my_role() <> 'customer' or noodle.my_customer_id() is null then raise exception 'not allowed'; end if;
  if noodle.my_location_id() is not null and noodle.my_location_id() <> p_store then raise exception 'not allowed'; end if;
  update noodle.customer_locations set
    address = nullif(left(trim(coalesce(p_address, '')), 500), ''),
    contact_person = nullif(left(trim(coalesce(p_contact, '')), 200), ''),
    phone = nullif(left(trim(coalesce(p_phone, '')), 60), ''),
    notes = nullif(left(trim(coalesce(p_notes, '')), 1000), '')
  where id = p_store and customer_id = noodle.my_customer_id();
  if not found then raise exception 'not allowed'; end if;
end $$;

revoke execute on function noodle.update_my_company(text, text, text, text, text, text, text) from public, anon;
revoke execute on function noodle.update_my_store(uuid, text, text, text, text) from public, anon;
grant execute on function noodle.update_my_company(text, text, text, text, text, text, text) to authenticated;
grant execute on function noodle.update_my_store(uuid, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
