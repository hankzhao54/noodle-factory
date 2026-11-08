-- =====================================================================
-- 017 · 匈牙利法定假日自动不送货
--   Statutory public holidays (Mt. 102. §) are computed every year, incl. Easter-based ones;
--   Dec 24 is a public holiday from 2026 on.
--   Bridge rest days (áthelyezett pihenőnap) are set by a yearly ministry decree: kept as an
--   editable list, closed only when "order_close_bridge_days" is on.
--   Manual closed dates (order_closed_dates) still work as before.
-- =====================================================================

insert into noodle.settings (key, value) values
  ('order_close_hu_holidays', 'true'),
  ('order_close_bridge_days', 'false'),
  ('order_bridge_days', '2026-01-02, 2026-08-21')   -- 10/2025. (IV. 30.) NGM rendelet
on conflict (key) do nothing;

create or replace function noodle.easter_sunday(y int) returns date
language plpgsql immutable as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; mo int; dy int;
begin
  a := y % 19; b := y / 100; c := y % 100; d := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19 * a + b - d - g + 15) % 30;
  i := c / 4; k := c % 4; l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  mo := (h + l - 7 * m + 114) / 31; dy := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(y, mo, dy);
end $$;

create or replace function noodle.hu_holidays(y int) returns table(day date, name text)
language sql immutable as $$
  select * from (values
    (make_date(y, 1, 1),  'Újév'),
    (make_date(y, 3, 15), 'Nemzeti ünnep (március 15.)'),
    (noodle.easter_sunday(y) - 2,  'Nagypéntek'),
    (noodle.easter_sunday(y),      'Húsvétvasárnap'),
    (noodle.easter_sunday(y) + 1,  'Húsvéthétfő'),
    (make_date(y, 5, 1),  'A munka ünnepe'),
    (noodle.easter_sunday(y) + 49, 'Pünkösdvasárnap'),
    (noodle.easter_sunday(y) + 50, 'Pünkösdhétfő'),
    (make_date(y, 8, 20), 'Államalapítás ünnepe'),
    (make_date(y, 10, 23), 'Nemzeti ünnep (október 23.)'),
    (make_date(y, 11, 1), 'Mindenszentek'),
    (make_date(y, 12, 24), 'Szenteste'),
    (make_date(y, 12, 25), 'Karácsony'),
    (make_date(y, 12, 26), 'Karácsony másnapja')
  ) as t(day, name)
  where not (extract(month from day) = 12 and extract(day from day) = 24 and y < 2026)
$$;

-- every date the factory does not deliver between two dates, with the reason
create or replace function noodle.closed_days(p_from date, p_to date) returns table(day date, name text)
language sql stable security definer set search_path = noodle, pg_temp as $$
  with s as (select key, value from noodle.settings)
  select distinct on (day) day, name from (
    select h.day, h.name from generate_series(extract(year from p_from)::int, extract(year from p_to)::int) y,
           lateral noodle.hu_holidays(y) h
     where coalesce((select value from s where key = 'order_close_hu_holidays'), 'true') = 'true'
    union all
    select x::date, 'Áthelyezett pihenőnap'
      from unnest(string_to_array(replace(coalesce((select value from s where key = 'order_bridge_days'), ''), ' ', ''), ',')) x
     where x ~ '^\d{4}-\d{2}-\d{2}$' and coalesce((select value from s where key = 'order_close_bridge_days'), 'false') = 'true'
    union all
    select x::date, null
      from unnest(string_to_array(replace(coalesce((select value from s where key = 'order_closed_dates'), ''), ' ', ''), ',')) x
     where x ~ '^\d{4}-\d{2}-\d{2}$'
  ) z
  where day between p_from and p_to
  order by day, name nulls last
$$;

create or replace function noodle.delivery_date_problem(p_customer uuid, p_date date) returns text
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare v_dow int := extract(isodow from p_date); v_fw text; v_cw smallint[];
begin
  if p_date < noodle.earliest_delivery_date() then return 'too_late'; end if;
  v_fw := coalesce((select value from noodle.settings where key = 'order_weekdays'), '');
  if v_fw <> '' and not (v_dow::text = any (string_to_array(replace(v_fw, ' ', ''), ','))) then return 'no_delivery_day'; end if;
  select delivery_weekdays into v_cw from noodle.customers where id = p_customer;
  if v_cw is not null and cardinality(v_cw) > 0 and not (v_dow = any (v_cw)) then return 'not_your_day'; end if;
  if exists (select 1 from noodle.closed_days(p_date, p_date)) then return 'closed'; end if;
  return '';
end $$;

-- closed_dates now = holidays + bridge days (if on) + manual dates, for the next ~13 months;
-- closed_list carries the names for display
create or replace function noodle.order_rules() returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select jsonb_build_object(
    'earliest', noodle.earliest_delivery_date(),
    'cutoff', (select value from noodle.settings where key = 'order_cutoff_time'),
    'lead_days', (select value from noodle.settings where key = 'order_lead_days'),
    'weekdays', (select value from noodle.settings where key = 'order_weekdays'),
    'closed_dates', (select string_agg(day::text, ',' order by day) from noodle.closed_days(current_date, current_date + 400)),
    'closed_list', (select coalesce(jsonb_agg(jsonb_build_object('date', day, 'name', name) order by day), '[]'::jsonb)
                      from noodle.closed_days(current_date, current_date + 400)),
    'my_weekdays', (select to_jsonb(delivery_weekdays) from noodle.customers where id = noodle.my_customer_id()))
$$;

revoke execute on all functions in schema noodle from anon, public;
revoke execute on function noodle.delivery_date_problem(uuid, date) from authenticated;
revoke execute on function noodle.closed_days(date, date) from authenticated;
revoke execute on function noodle.price_for(uuid, uuid) from authenticated;
grant execute on function noodle.public_info() to anon, authenticated;
grant execute on function noodle.order_rules() to authenticated;
grant execute on function noodle.hu_holidays(int) to authenticated;

notify pgrst, 'reload schema';
