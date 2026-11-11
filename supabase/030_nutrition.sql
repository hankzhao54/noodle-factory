-- =====================================================================
-- 030 · 营养成分（每 100 g），给外部客户的标签用
--   Values computed from the recipe (BL80 flour per its pack, standard data for the rest),
--   salt = all sodium × 2.5 (incl. baking soda). Raw fresh noodles.
-- =====================================================================
alter table noodle.products
  add column if not exists nut_kj numeric(8,1),
  add column if not exists nut_kcal numeric(8,1),
  add column if not exists nut_fat numeric(6,1),
  add column if not exists nut_saturates numeric(6,1),
  add column if not exists nut_carbs numeric(6,1),
  add column if not exists nut_sugars numeric(6,1),
  add column if not exists nut_fibre numeric(6,1),
  add column if not exists nut_protein numeric(6,1),
  add column if not exists nut_salt numeric(6,2);

update noodle.products set nut_kj = 1161, nut_kcal = 274, nut_fat = 1.2, nut_saturates = 0.3, nut_carbs = 54.7,
       nut_sugars = 1.5, nut_fibre = 2.2, nut_protein = 10.0, nut_salt = 2.0
 where code in ('101-RAMEN', '101-SOBA') and nut_kj is null;
update noodle.products set nut_kj = 1169, nut_kcal = 276, nut_fat = 1.2, nut_saturates = 0.3, nut_carbs = 55.1,
       nut_sugars = 1.5, nut_fibre = 2.2, nut_protein = 10.0, nut_salt = 1.9
 where code = '101-UDON' and nut_kj is null;
notify pgrst, 'reload schema';
