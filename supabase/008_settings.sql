-- =====================================================================
-- 008 · 系统设置（标签上的生产商信息等）
--   key/value; staff can read, admin can change
-- =====================================================================

create table if not exists noodle.settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

alter table noodle.settings enable row level security;
drop policy if exists staff_read on noodle.settings;
drop policy if exists admin_write on noodle.settings;
create policy staff_read on noodle.settings for select to authenticated using (noodle.is_staff());
create policy admin_write on noodle.settings for all to authenticated
  using (noodle.is_admin()) with check (noodle.is_admin());

grant select, insert, update, delete on noodle.settings to authenticated;

insert into noodle.settings (key, value) values
  ('label_producer', ''),
  ('label_address', ''),
  ('label_extra', '')
on conflict (key) do nothing;
