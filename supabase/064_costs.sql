-- =====================================================================
-- 064 · 成本分析（只有指定的人能看）/ Cost analysis, visible to named people only
--   noodle.cost_viewers   — who may open the Costs page (not every admin: Hank only for now).
--                           Managed by SQL only; nobody can add themselves from the app.
--   noodle.cost_settings  — rent, utilities, employer tax per person, internal price, planning rate …
--   noodle.cost_report(from, to) — output, materials used, deliveries/revenue for a period.
--   Labour hours and wages come from 101base (ShiftDesk) through the edge function noodle-costs.
-- =====================================================================
create table if not exists noodle.cost_viewers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table noodle.cost_viewers enable row level security;
-- nobody reads or writes it through the API; is_cost_viewer() looks it up
revoke all on noodle.cost_viewers from anon, authenticated;

insert into noodle.cost_viewers (user_id) values ('bc6817df-c949-4d78-9331-0a7172c886aa')  -- Hank
on conflict do nothing;

create or replace function noodle.is_cost_viewer() returns boolean
language sql stable security definer set search_path = noodle, pg_temp as $$
  select exists (select 1 from noodle.cost_viewers where user_id = auth.uid())
$$;
revoke execute on function noodle.is_cost_viewer() from public, anon;
grant execute on function noodle.is_cost_viewer() to authenticated;

create table if not exists noodle.cost_settings (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz not null default now()
);
alter table noodle.cost_settings enable row level security;
drop policy if exists viewers on noodle.cost_settings;
create policy viewers on noodle.cost_settings for all to authenticated
  using (noodle.is_cost_viewer()) with check (noodle.is_cost_viewer());
grant select, insert, update on noodle.cost_settings to authenticated;
drop trigger if exists audit on noodle.cost_settings;
create trigger audit after insert or update or delete on noodle.cost_settings for each row execute function noodle.audit_trigger();

insert into noodle.cost_settings (key, value) values
  ('rent_month', 300000),          -- Ft / month
  ('utilities_month', 30000),      -- Ft / month
  ('tax_per_person_month', 80000), -- employer tax, Ft / person / month
  ('tax_people', 2),
  ('internal_price', 1800),        -- Ft / kg, own restaurants
  ('plan_kg_per_hour', 5),
  ('work_days_month', 22)
on conflict (key) do nothing;

-- Output, materials and deliveries of a period (dates in Budapest time, both ends included).
create or replace function noodle.cost_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare
  t_from timestamptz := (p_from::timestamp at time zone 'Europe/Budapest');
  t_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Europe/Budapest');
begin
  if not noodle.is_cost_viewer() then raise exception 'not allowed'; end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'bad period'; end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from noodle.cost_settings),
    'production', (select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
        select jsonb_build_object('name', p.name_hu, 'batches', sum(b.batches),
                 'actual', sum(b.actual_qty), 'theoretical', sum(b.batches * p.batch_yield),
                 'unweighed', count(*) filter (where abs(b.actual_qty - b.batches * p.batch_yield) < 0.01)) x
        from noodle.production_batches b join noodle.products p on p.id = b.product_id
        where b.status = 'done' and b.actual_qty is not null and b.done_at >= t_from and b.done_at < t_to
        group by p.id, p.name_hu) s),
    'materials', (select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') from (
        select jsonb_build_object('name', m.name_hu, 'unit', m.unit, 'used', -sum(s.qty),
                 'price', m.cost_per_unit, 'value', -sum(s.qty) * coalesce(m.cost_per_unit, 0)) x
        from noodle.stock_movements s join noodle.materials m on m.id = s.material_id
        where s.reason = 'production_use' and s.created_at >= t_from and s.created_at < t_to
        group by m.id, m.name_hu, m.unit, m.cost_per_unit) s),
    'deliveries', (select coalesce(jsonb_agg(x), '[]') from (
        select jsonb_build_object('type', c.type,
                 'kg', sum(coalesce(l.delivered_qty, l.qty)),
                 'value', sum(coalesce(l.delivered_qty, l.qty) * (l.unit_price + coalesce(l.vacuum_fee, 0) + coalesce(l.portion_fee, 0)))) x
        from noodle.orders o join noodle.customers c on c.id = o.customer_id join noodle.order_lines l on l.order_id = o.id
        where o.status = 'delivered' and o.delivery_date between p_from and p_to
        group by c.type) s)
  );
end $$;
revoke execute on function noodle.cost_report(date, date) from public, anon;
grant execute on function noodle.cost_report(date, date) to authenticated;

notify pgrst, 'reload schema';

-- Shared token for 101base's integration_pastafactory_labor(). Read only by the edge function noodle-costs
-- (service role). The row itself is inserted by hand (not in this file): name = 'labor_101base_token'.
create table if not exists noodle.integration_secrets (
  name  text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table noodle.integration_secrets enable row level security;
revoke all on noodle.integration_secrets from anon, authenticated;
grant select on noodle.cost_viewers, noodle.integration_secrets to service_role;
