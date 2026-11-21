-- =====================================================================
-- 060 · szamlazz.hu 正式发票（Számla Agent）
--   Official invoices are issued by the edge function noodle-szamlazz (service role) and stored in
--   noodle.invoices with kind = 'invoice'. The browser can still only save díjbekérő (proforma) rows.
--   At most one live invoice per customer / store / month (a storno would set cancelled_at).
--   Settings: szamlazz_einvoice (e-számla instead of paper), szamlazz_send_email (szamlazz.hu e-mails the buyer).
-- =====================================================================
alter table noodle.invoices add column if not exists fulfillment_date date;
alter table noodle.invoices add column if not exists einvoice boolean;
alter table noodle.invoices add column if not exists cancelled_at timestamptz;

create unique index if not exists invoices_one_live_invoice
  on noodle.invoices (customer_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), month)
  where kind = 'invoice' and cancelled_at is null;

-- staff (browser) may only write proforma rows; official invoices come from szamlazz.hu via the edge function
drop policy if exists staff_all on noodle.invoices;
drop policy if exists staff_read on noodle.invoices;
drop policy if exists staff_proforma on noodle.invoices;
create policy staff_read on noodle.invoices for select to authenticated using (noodle.is_staff());
create policy staff_proforma on noodle.invoices for insert to authenticated with check (noodle.is_staff() and kind = 'proforma');

insert into noodle.settings (key, value) values
  ('szamlazz_einvoice', 'true'),
  ('szamlazz_send_email', 'true')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
