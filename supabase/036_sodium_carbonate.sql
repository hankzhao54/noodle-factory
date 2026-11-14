-- =====================================================================
-- 036 · 配方修正：Ramen / Soba 用的是碳酸钠 E500(i)，不是小苏打 E500(ii)   (data fix, applied 2026-11-14)
--   New material M-E500I; recipe lines and the production use already booked moved over to it.
--   Salt per 100 g for Ramen/Soba recalculated with sodium carbonate's sodium: 2.1 g.
--   The baking-soda material (BK-221900000026) stays as a purchasable item, now unused.
-- =====================================================================
with nm as (
  insert into noodle.materials (code, name_zh, name_en, name_hu, unit, category, ingredient_hu, ingredient_en, ingredient_zh, allergens, on_label, track_stock, min_mode, cost_per_unit, min_stock, active)
  values ('M-E500I', '碳酸钠 E500(i)', 'Sodium carbonate E500(i)', 'Nátrium-karbonát E500(i)', 'kg', '辅料',
          'savanyúságot szabályozó anyag (E500)', 'acidity regulator (E500)', '酸度调节剂（E500）', '{}', true, true, 'auto', 0, 0, true)
  on conflict do nothing
  returning id
)
update noodle.recipe_lines set material_id = (select id from nm)
 where material_id = (select id from noodle.materials where code = 'BK-221900000026') and exists (select 1 from nm);
update noodle.stock_movements set material_id = (select id from noodle.materials where code = 'M-E500I')
 where material_id = (select id from noodle.materials where code = 'BK-221900000026') and reason = 'production_use';
update noodle.products set nut_salt = 2.1 where code in ('101-RAMEN', '101-SOBA');
