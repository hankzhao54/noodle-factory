-- =====================================================================
-- 101base (ShiftDesk project rwineoyuhzwqtarnzkpq) · read-only labour feed for the noodle factory Costs page.
--   public.integration_pastafactory_labor(token, from, to)
--     → one row per timecard at the location "101 Pastafactory": day, person, paid hours, hourly wage.
--   Callable with the anon key, but only with the shared token whose SHA-256 is in private.integration_tokens
--   (name 'noodle-costs'). The token itself lives only in the noodle project's edge-function secret
--   LABOR_101BASE_TOKEN. Returns nothing about any other location.
-- =====================================================================
create table if not exists private.integration_tokens (
  name       text primary key,
  token_hash text not null,          -- hex sha256 of the token
  created_at timestamptz not null default now()
);
alter table private.integration_tokens enable row level security;
revoke all on private.integration_tokens from anon, authenticated;

create or replace function public.integration_pastafactory_labor(p_token text, p_from date, p_to date)
returns table (day date, person text, hours numeric, hourly_wage numeric, pay_type text, open_card boolean)
language plpgsql stable security definer set search_path = public, private, pg_temp as $$
begin
  if p_token is null or not exists (
       select 1 from private.integration_tokens
       where name = 'noodle-costs' and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')) then
    raise exception 'forbidden';
  end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'bad period'; end if;
  return query
    select (t.clock_in_at at time zone coalesce(l.timezone, 'Europe/Budapest'))::date,
           trim(p.first_name || ' ' || coalesce(p.last_name, '')),
           round((greatest(extract(epoch from (coalesce(t.clock_out_at, t.clock_in_at) - t.clock_in_at)) / 3600
                  - coalesce((select sum(extract(epoch from (b.end_at - b.start_at)) / 3600)
                              from public.time_breaks b
                              where b.timecard_id = t.id and not b.paid and not coalesce(b.waived, false) and b.end_at is not null), 0), 0))::numeric, 2),
           coalesce((select jr.hourly_wage from public.job_roles jr where jr.job_id = j.id and jr.role_id = t.role_id),
                    (select jr.hourly_wage from public.job_roles jr where jr.job_id = j.id and jr.is_primary limit 1)),
           j.pay_type::text,
           t.clock_out_at is null
    from public.timecards t
    join public.locations l on l.id = t.location_id
    join public.jobs j on j.id = t.job_id
    join public.profiles p on p.id = j.profile_id
    where l.name = '101 Pastafactory'
      and (t.clock_in_at at time zone coalesce(l.timezone, 'Europe/Budapest'))::date between p_from and p_to
    order by 1, 2;
end $$;
revoke execute on function public.integration_pastafactory_labor(text, date, date) from public;
grant execute on function public.integration_pastafactory_labor(text, date, date) to anon, authenticated;
notify pgrst, 'reload schema';
