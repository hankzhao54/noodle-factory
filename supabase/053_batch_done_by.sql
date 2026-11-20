-- =====================================================================
-- 053 · 生产列表显示谁做的：记录完成生产的人
--   production_batches.done_by is set when a batch goes planned → done (cleared on undo).
--   Older batches are filled from who booked their stock entry.
--   (NOT YET APPLIED to the live database — waiting for the user to approve the migration)
-- =====================================================================
alter table noodle.production_batches add column if not exists done_by uuid;

create or replace function noodle.batch_set_done_by() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then new.done_by := coalesce(auth.uid(), new.done_by);
  elsif new.status <> 'done' then new.done_by := null;
  end if;
  return new;
end $$;
revoke execute on function noodle.batch_set_done_by() from public, anon, authenticated;
drop trigger if exists set_done_by on noodle.production_batches;
create trigger set_done_by before update of status on noodle.production_batches
  for each row execute function noodle.batch_set_done_by();

update noodle.production_batches b set done_by = m.created_by
  from noodle.stock_movements m
 where b.status = 'done' and b.done_by is null and m.ref_id = b.id and m.reason = 'production_out' and m.created_by is not null;
update noodle.production_batches set done_by = created_by where status = 'done' and done_by is null;
notify pgrst, 'reload schema';
