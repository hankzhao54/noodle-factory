-- =====================================================================
-- 010 · 标签预设：每个产品的每张标签默认数量（kg），全局兜底的保质期和数量
-- =====================================================================
alter table noodle.products add column if not exists label_qty_kg numeric(12,3);

insert into noodle.settings (key, value) values
  ('label_default_shelf_days', ''),
  ('label_default_qty_kg', '')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
