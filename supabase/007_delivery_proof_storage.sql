-- =====================================================================
-- 007 · 签收照片存储桶 (Supabase Storage)
--   private bucket, path = <order_id>/<file>
--   staff only: upload / view / download / delete. Customers never see proof photos.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('noodle-delivery-proofs', 'noodle-delivery-proofs', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "noodle proofs staff insert" on storage.objects;
drop policy if exists "noodle proofs staff select" on storage.objects;
drop policy if exists "noodle proofs staff delete" on storage.objects;
drop policy if exists "noodle proofs customer select" on storage.objects;

create policy "noodle proofs staff insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'noodle-delivery-proofs' and noodle.is_staff());
create policy "noodle proofs staff select" on storage.objects for select to authenticated
  using (bucket_id = 'noodle-delivery-proofs' and noodle.is_staff());
create policy "noodle proofs staff delete" on storage.objects for delete to authenticated
  using (bucket_id = 'noodle-delivery-proofs' and noodle.is_staff());
-- 签收照片只给内部看：客户和内部餐厅账号都没有读取权限。
