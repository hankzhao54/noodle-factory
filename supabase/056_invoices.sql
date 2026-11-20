-- =====================================================================
-- 056 · 已生成的发票（díjbekérő PDF）：记录 + 存文件，报告里能看到并直接打开
--   noodle.invoices: one row per generated PDF (regenerating adds a new row; the latest counts).
--   PDFs live in the private bucket noodle-invoices (<month>/<number>-<time>.pdf), staff only.
--   Later the szamlazz.hu number / link of the official invoice can be stored on the same row.
-- =====================================================================
create table if not exists noodle.invoices (
  id           uuid primary key default gen_random_uuid(),
  number       text not null,
  kind         text not null default 'proforma' check (kind in ('proforma', 'invoice')),
  customer_id  uuid not null references noodle.customers(id),
  location_id  uuid references noodle.customer_locations(id),
  month        date not null,                -- first day of the month invoiced
  period_from  date not null,
  period_to    date not null,
  issue_date   date not null default (now() at time zone 'Europe/Budapest')::date,
  due_date     date,
  vat_rate     numeric(5,2),
  net          numeric(14,2) not null default 0,
  vat          numeric(14,2) not null default 0,
  gross        numeric(14,2) not null default 0,
  lines        jsonb not null default '[]',
  file_path    text,
  external_id  text,                          -- szamlazz.hu invoice number (later)
  external_url text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists invoices_month on noodle.invoices(month, customer_id, location_id, created_at desc);

alter table noodle.invoices enable row level security;
drop policy if exists staff_all on noodle.invoices;
create policy staff_all on noodle.invoices for all to authenticated using (noodle.is_staff()) with check (noodle.is_staff());
grant select, insert, update on noodle.invoices to authenticated;
drop trigger if exists audit on noodle.invoices;
create trigger audit after insert or update or delete on noodle.invoices for each row execute function noodle.audit_trigger();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('noodle-invoices', 'noodle-invoices', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "noodle invoices staff insert" on storage.objects;
drop policy if exists "noodle invoices staff select" on storage.objects;
create policy "noodle invoices staff insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'noodle-invoices' and noodle.is_staff());
create policy "noodle invoices staff select" on storage.objects for select to authenticated
  using (bucket_id = 'noodle-invoices' and noodle.is_staff());
notify pgrst, 'reload schema';
