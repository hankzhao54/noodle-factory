-- =====================================================================
-- 011 · 原料和产品图片
--   bucket noodle-images (public read, so the ordering page can show product photos)
--   path = materials/<id>/<file> or products/<id>/<file>; only staff can upload / delete
-- =====================================================================
alter table noodle.materials add column if not exists image_path text;
alter table noodle.products  add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('noodle-images', 'noodle-images', true, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update set public = true,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "noodle images staff insert" on storage.objects;
drop policy if exists "noodle images staff update" on storage.objects;
drop policy if exists "noodle images staff delete" on storage.objects;
drop policy if exists "noodle images staff select" on storage.objects;
create policy "noodle images staff select" on storage.objects for select to authenticated
  using (bucket_id = 'noodle-images' and noodle.is_staff());
create policy "noodle images staff insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'noodle-images' and noodle.is_staff());
create policy "noodle images staff update" on storage.objects for update to authenticated
  using (bucket_id = 'noodle-images' and noodle.is_staff());
create policy "noodle images staff delete" on storage.objects for delete to authenticated
  using (bucket_id = 'noodle-images' and noodle.is_staff());

-- the customer catalog also returns the product photo
create or replace view noodle.my_catalog with (security_invoker = on) as
select p.id, p.code, p.name_zh, p.name_en, p.name_hu, p.description, p.unit,
       p.pack_size_g, p.shelf_life_days, p.storage,
       (case when noodle.my_role() = 'restaurant' then 0 else p.min_order_qty end)::numeric(12,3) as min_order_qty,
       p.sort,
       (case when noodle.my_role() = 'restaurant' then null
             else coalesce(cp.price, p.base_price) end)::numeric(12,2) as price,
       p.image_path
from noodle.products p
left join noodle.customer_prices cp
       on cp.product_id = p.id and cp.customer_id = noodle.my_customer_id()
where p.active and p.visible_to_customers;
grant select on noodle.my_catalog to authenticated;

notify pgrst, 'reload schema';
