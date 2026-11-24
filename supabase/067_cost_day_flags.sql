-- =====================================================================
-- 067 · 成本分析：标记「这天不算做面」/ Costs: mark a day as not production
--   A marked day's hours count as other work (packing, admin) on the Costs page and stay out of efficiency;
--   labour cost still counts them. Cost viewers only. 2026-11-18 marked (mostly packing that day).
-- =====================================================================
create table if not exists noodle.cost_day_flags (
  day        date primary key,
  note       text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table noodle.cost_day_flags enable row level security;
drop policy if exists viewers on noodle.cost_day_flags;
create policy viewers on noodle.cost_day_flags for all to authenticated
  using (noodle.is_cost_viewer()) with check (noodle.is_cost_viewer());
grant select, insert, update, delete on noodle.cost_day_flags to authenticated;
drop trigger if exists audit on noodle.cost_day_flags;
create trigger audit after insert or update or delete on noodle.cost_day_flags for each row execute function noodle.audit_trigger();

insert into noodle.cost_day_flags (day, note) values ('2026-11-18', 'Főleg csomagolás / 大部分时间在打包')
on conflict (day) do nothing;
notify pgrst, 'reload schema';
