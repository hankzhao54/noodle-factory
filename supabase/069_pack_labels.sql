-- =====================================================================
-- 069 · 打包标签 / Packing labels
--   Boxes of one production batch are later packed into smaller packs that need new labels.
--   Those labels are printed from the "Packing labels" page, always from a chosen batch: they keep the batch's
--   lot number (with a pack number: 261123-30/P01, /P02 …), production time and use-by date.
--   noodle.pack_labels records every print run, so the page can warn when a batch has been packed before,
--   and the trace page shows the packing history of a lot.
--   reserve_pack_labels(batch, count, qty, unit, note) → first pack number of this run (numbers continue per batch).
-- =====================================================================
create table if not exists noodle.pack_labels (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references noodle.production_batches(id) on delete cascade,
  product_id      uuid not null references noodle.products(id),
  lot_no          text not null,
  seq_from        int not null,
  seq_to          int not null,
  labels          int not null check (labels > 0),
  qty_per_label   numeric,
  unit            text,
  note            text,
  printed_by      uuid default auth.uid(),
  printed_by_name text,
  printed_at      timestamptz not null default now()
);
create index if not exists pack_labels_batch on noodle.pack_labels (batch_id, printed_at);

alter table noodle.pack_labels enable row level security;
drop policy if exists staff_read on noodle.pack_labels;
create policy staff_read on noodle.pack_labels for select to authenticated using (noodle.is_staff());
grant select on noodle.pack_labels to authenticated;   -- written only through reserve_pack_labels()
drop trigger if exists audit on noodle.pack_labels;
create trigger audit after insert or update or delete on noodle.pack_labels for each row execute function noodle.audit_trigger();

create or replace function noodle.reserve_pack_labels(p_batch uuid, p_labels int, p_qty numeric, p_unit text, p_note text default null)
returns int
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare b noodle.production_batches; v_from int;
begin
  if not noodle.is_staff() then raise exception 'staff only'; end if;
  if p_labels is null or p_labels < 1 or p_labels > 200 then raise exception 'bad label count'; end if;
  select * into b from noodle.production_batches where id = p_batch for update;
  if b.id is null then raise exception 'batch not found'; end if;
  if b.status <> 'done' or b.lot_no is null then raise exception 'batch not finished'; end if;
  select coalesce(max(seq_to), 0) + 1 into v_from from noodle.pack_labels where batch_id = b.id;
  insert into noodle.pack_labels (batch_id, product_id, lot_no, seq_from, seq_to, labels, qty_per_label, unit, note, printed_by_name)
  values (b.id, b.product_id, b.lot_no, v_from, v_from + p_labels - 1, p_labels, p_qty, p_unit, nullif(trim(p_note), ''),
          (select coalesce(nullif(display_name, ''), (select email from auth.users where id = auth.uid())) from noodle.profiles where user_id = auth.uid()));
  return v_from;
end $$;
revoke execute on function noodle.reserve_pack_labels(uuid, int, numeric, text, text) from public, anon;
grant execute on function noodle.reserve_pack_labels(uuid, int, numeric, text, text) to authenticated;

notify pgrst, 'reload schema';
