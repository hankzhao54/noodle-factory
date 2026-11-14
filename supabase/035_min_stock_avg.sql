-- =====================================================================
-- 035 · 自动最低库存：近 4 周平均周用量，且至少一包
--   auto threshold = average weekly production use over the last 4 weeks (fewer weeks while
--   there is less history, at least 1 week), raised to one pack (but not past 4 weeks of use),
--   so slow, cheap materials are reordered when the last pack is opened.
--   used_7d now holds that weekly average.
-- =====================================================================
create or replace view noodle.material_stock with (security_invoker = on) as
with first_use as (
  select min(created_at) as at from noodle.stock_movements where reason = 'production_use'
), used as (
  select material_id, -sum(qty) as used_28d
  from noodle.stock_movements
  where reason = 'production_use' and material_id is not null and created_at >= now() - interval '28 days'
  group by material_id
), weeks as (
  select greatest(1, least(4, extract(epoch from now() - coalesce((select at from first_use), now())) / 604800.0)) as n
), base as (
  select m.*, coalesce(sum(s.qty), 0) as on_hand_raw,
         coalesce(u.used_28d, 0) / (select n from weeks) as weekly
  from noodle.materials m
  left join noodle.stock_movements s on s.material_id = m.id
  left join used u on u.material_id = m.id
  where m.active and m.stock_as is null
  group by m.id, u.used_28d
), eff as (
  select b.*, case when min_mode = 'auto'
                   then case when weekly > 0 then greatest(weekly, least(coalesce(pack_size, 0), 4 * weekly)) else 0 end
                   else min_stock end as min_eff
  from base b
)
select id, code, name_zh, name_en, name_hu, category, unit,
       min_eff::numeric(12,3) as min_stock,
       cost_per_unit, default_supplier_id,
       on_hand_raw::numeric(12,3) as on_hand,
       track_stock and on_hand_raw < min_eff as below_min,
       track_stock,
       min_mode,
       min_stock::numeric(12,3) as min_manual,
       weekly::numeric(12,3) as used_7d
from eff;

grant select on noodle.material_stock to authenticated;
notify pgrst, 'reload schema';
