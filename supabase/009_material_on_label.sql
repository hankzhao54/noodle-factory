-- =====================================================================
-- 009 · 原料是否印在标签配料表上（包装材料不印）
-- =====================================================================
alter table noodle.materials add column if not exists on_label boolean not null default true;

-- packaging counted by piece / pack / box is not an ingredient
update noodle.materials set on_label = false where unit in ('pcs', 'pack', 'box');
