-- =====================================================================
-- 063 · 月底报告：手动「已开票」标记（发票在 szamlazz.hu 网页上手动开，这里只记哪家店哪个月开好了）
--   noodle.invoice_marks: one row per customer / store / month; click again to remove.
--   Also drops the month-end lock (057): the report and invoices are no longer restricted to after month end.
-- =====================================================================
create table if not exists noodle.invoice_marks (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references noodle.customers(id) on delete cascade,
  location_id  uuid references noodle.customer_locations(id) on delete cascade,
  month        date not null,                 -- first day of the month
  number       text,                          -- optional invoice number
  done_by      uuid default auth.uid(),
  done_by_name text,
  done_at      timestamptz not null default now()
);
create unique index if not exists invoice_marks_one
  on noodle.invoice_marks (customer_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), month);

create or replace function noodle.invoice_mark_who() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  new.done_by := auth.uid();
  new.done_by_name := coalesce((select display_name from noodle.profiles where user_id = auth.uid()), new.done_by_name);
  return new;
end $$;
revoke execute on function noodle.invoice_mark_who() from public, anon, authenticated;
drop trigger if exists who on noodle.invoice_marks;
create trigger who before insert on noodle.invoice_marks for each row execute function noodle.invoice_mark_who();

alter table noodle.invoice_marks enable row level security;
drop policy if exists staff_all on noodle.invoice_marks;
create policy staff_all on noodle.invoice_marks for all to authenticated using (noodle.is_staff()) with check (noodle.is_staff());
grant select, insert, update, delete on noodle.invoice_marks to authenticated;
drop trigger if exists audit on noodle.invoice_marks;
create trigger audit after insert or update or delete on noodle.invoice_marks for each row execute function noodle.audit_trigger();

-- no more month-end lock
drop trigger if exists month_closed on noodle.invoices;
notify pgrst, 'reload schema';
