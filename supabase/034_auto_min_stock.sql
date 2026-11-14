-- =====================================================================
-- 034 · 原料最低库存按上周用量自动算
--   materials.min_mode: 'auto' (default) = the threshold is what production used in the last
--   7 days; 'manual' = the min_stock typed in on the Materials page.
--   material_stock.min_stock is the threshold in force (so stock warnings, the dashboard and the
--   purchase suggestion — 2 × threshold − stock, i.e. about two weeks — follow it);
--   min_manual / used_7d / min_mode show where it comes from.
-- =====================================================================
alter table noodle.materials add column if not exists min_mode text not null default 'auto';
alter table noodle.materials drop constraint if exists materials_min_mode_check;
alter table noodle.materials add constraint materials_min_mode_check check (min_mode in ('auto', 'manual'));

create or replace view noodle.material_stock with (security_invoker = on) as
with used as (
  select material_id, -sum(qty) as used_7d
  from noodle.stock_movements
  where reason = 'production_use' and material_id is not null and created_at >= now() - interval '7 days'
  group by material_id
), base as (
  select m.*, coalesce(sum(s.qty), 0) as on_hand_raw, coalesce(u.used_7d, 0) as used_raw
  from noodle.materials m
  left join noodle.stock_movements s on s.material_id = m.id
  left join used u on u.material_id = m.id
  where m.active and m.stock_as is null
  group by m.id, u.used_7d
)
select id, code, name_zh, name_en, name_hu, category, unit,
       (case when min_mode = 'auto' then used_raw else min_stock end)::numeric(12,3) as min_stock,
       cost_per_unit, default_supplier_id,
       on_hand_raw::numeric(12,3) as on_hand,
       track_stock and on_hand_raw < (case when min_mode = 'auto' then used_raw else min_stock end) as below_min,
       track_stock,
       min_mode,
       min_stock::numeric(12,3) as min_manual,
       used_raw::numeric(12,3) as used_7d
from base;

grant select on noodle.material_stock to authenticated;
notify pgrst, 'reload schema';
