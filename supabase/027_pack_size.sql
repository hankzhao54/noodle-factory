-- =====================================================================
-- 027 · 原料包装规格（每袋多少 kg）
--   Stock, recipes and prices stay per base unit (kg). pack_size only lets people enter purchases
--   in bags / packs and see the price per bag: qty = bags × pack_size, price per kg = bag price ÷ pack_size.
-- =====================================================================
alter table noodle.materials add column if not exists pack_size numeric(12,3) check (pack_size is null or pack_size > 0);

update noodle.materials m set pack_size = x.size
from (values
  ('BK-370000006907', 40), ('BK-202410000069', 2), ('BK-202410000071', 1),
  ('BK-202411000001', 25), ('BK-202411000002', 25), ('BK-202411000004', 25), ('BK-202411000005', 25),
  ('BK-370000014331', 25), ('BK-202300000002', 1), ('BK-221900000026', 2)
) as x(code, size)
where m.code = x.code and m.pack_size is null;
notify pgrst, 'reload schema';
