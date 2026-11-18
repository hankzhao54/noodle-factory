-- =====================================================================
-- 048 · 打包：有的客户需要打包，打好包在送货页点一下记录
--   customers.needs_packing — this customer's orders have to be packed before delivery.
--   orders.packed_at / packed_by / packed_by_name — who packed it and when.
--   set_order_packed(order, packed): staff only; a confirmed order becomes "ready" when packed
--   and goes back to "confirmed" when the mark is taken back.
-- =====================================================================
alter table noodle.customers add column if not exists needs_packing boolean not null default false;
alter table noodle.orders add column if not exists packed_at timestamptz;
alter table noodle.orders add column if not exists packed_by uuid;
alter table noodle.orders add column if not exists packed_by_name text;

create or replace function noodle.set_order_packed(p_order uuid, p_packed boolean) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare o noodle.orders;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  select * into o from noodle.orders where id = p_order for update;
  if o.id is null then raise exception 'order not found'; end if;
  if o.status not in ('submitted', 'confirmed', 'ready') then raise exception 'order can no longer be changed'; end if;
  if p_packed then
    update noodle.orders set packed_at = now(), packed_by = auth.uid(),
      packed_by_name = (select coalesce(nullif(display_name, ''), (select email from auth.users where id = auth.uid())) from noodle.profiles where user_id = auth.uid()),
      status = case when status = 'confirmed' then 'ready' else status end
     where id = o.id;
  else
    update noodle.orders set packed_at = null, packed_by = null, packed_by_name = null,
      status = case when status = 'ready' then 'confirmed' else status end
     where id = o.id;
  end if;
end $$;
revoke execute on function noodle.set_order_packed(uuid, boolean) from public, anon;
grant execute on function noodle.set_order_packed(uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
