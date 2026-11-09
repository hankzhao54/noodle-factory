-- =====================================================================
-- 021 · 员工打卡、工时、排班（面条工厂）
--   employees            people who clock in (optionally linked to a login: role 'worker' / staff / admin)
--   employee_pins        PIN hashes for the shared clock computer (no API access at all)
--   time_entries         one row per shift worked: clock_in → clock_out, with the check result
--   time_breaks          breaks inside an entry
--   shifts               the schedule
--   Clock rule (settings clock_mode): none | wifi | location | either | both
--     wifi     = the request comes from the company network's public IP (clock_ips, IPs or CIDR ranges)
--     location = the browser's GPS position is within clock_radius_m of clock_lat/clock_lng
--   Roles: worker (clock + own schedule/hours only), kiosk (shared computer: name + PIN).
--   Privacy: GPS coordinates are not stored, only the distance and accuracy.
-- =====================================================================

alter table noodle.profiles drop constraint if exists profiles_role_check;
alter table noodle.profiles add constraint profiles_role_check
  check (role in ('admin', 'staff', 'customer', 'restaurant', 'worker', 'kiosk', 'pending'));

insert into noodle.settings (key, value) values
  ('clock_mode', 'either'),
  ('clock_ips', ''),
  ('clock_lat', ''),
  ('clock_lng', ''),
  ('clock_radius_m', '150'),
  ('clock_max_accuracy_m', '200')
on conflict (key) do nothing;

create table if not exists noodle.employees (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  user_id     uuid unique references noodle.profiles(user_id) on delete set null,
  position    text,
  phone       text,
  color       text,
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists noodle.employee_pins (
  employee_id  uuid primary key references noodle.employees(id) on delete cascade,
  pin_hash     text not null,
  failed       integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

create table if not exists noodle.time_entries (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references noodle.employees(id) on delete cascade,
  clock_in    timestamptz not null,
  clock_out   timestamptz,
  source_in   text not null default 'self',     -- self | kiosk | admin
  source_out  text,
  check_in    jsonb,                            -- {ip, distance_m, accuracy_m, by}
  check_out   jsonb,
  note        text,
  created_at  timestamptz not null default now(),
  check (clock_out is null or clock_out >= clock_in)
);
create unique index if not exists time_entries_one_open on noodle.time_entries (employee_id) where clock_out is null;
create index if not exists time_entries_emp_in on noodle.time_entries (employee_id, clock_in desc);

create table if not exists noodle.time_breaks (
  id        uuid primary key default gen_random_uuid(),
  entry_id  uuid not null references noodle.time_entries(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at   timestamptz,
  check (ends_at is null or ends_at >= starts_at)
);
create index if not exists time_breaks_entry on noodle.time_breaks (entry_id);

create table if not exists noodle.shifts (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references noodle.employees(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  note        text,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists shifts_emp_start on noodle.shifts (employee_id, starts_at);
create index if not exists shifts_start on noodle.shifts (starts_at);

-- the employee record of the signed-in user
create or replace function noodle.my_employee_id() returns uuid
language sql stable security definer set search_path = noodle, pg_temp as $$
  select id from noodle.employees where user_id = auth.uid() and active
$$;

-- RLS: staff read everything, admins change it; workers read their own rows
alter table noodle.employees enable row level security;
alter table noodle.employee_pins enable row level security;
alter table noodle.time_entries enable row level security;
alter table noodle.time_breaks enable row level security;
alter table noodle.shifts enable row level security;
do $$
declare t text;
begin
  foreach t in array array['employees', 'time_entries', 'shifts', 'time_breaks'] loop
    execute format('drop policy if exists staff_read on noodle.%I', t);
    execute format('drop policy if exists admin_write on noodle.%I', t);
    execute format('drop policy if exists own_read on noodle.%I', t);
    execute format('create policy staff_read on noodle.%I for select to authenticated using (noodle.is_staff())', t);
    execute format('create policy admin_write on noodle.%I for all to authenticated using (noodle.is_admin()) with check (noodle.is_admin())', t);
  end loop;
end $$;
create policy own_read on noodle.employees for select to authenticated using (user_id = auth.uid());
create policy own_read on noodle.time_entries for select to authenticated using (employee_id = noodle.my_employee_id());
create policy own_read on noodle.shifts for select to authenticated using (employee_id = noodle.my_employee_id());
create policy own_read on noodle.time_breaks for select to authenticated
  using (exists (select 1 from noodle.time_entries e where e.id = time_breaks.entry_id and e.employee_id = noodle.my_employee_id()));
grant select, insert, update, delete on noodle.employees, noodle.time_entries, noodle.time_breaks, noodle.shifts to authenticated;
revoke all on noodle.employee_pins from anon, authenticated;   -- only security-definer functions touch PINs

-- client IP as seen by the API gateway (cf-connecting-ip is set by the proxy; the last x-forwarded-for hop is the proxy's view)
create or replace function noodle.client_ip() returns text
language plpgsql stable as $$
declare h json; v text; xff text[];
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  if h is null then return null; end if;
  v := nullif(trim(h ->> 'cf-connecting-ip'), '');
  if v is null and h ->> 'x-forwarded-for' is not null then
    xff := string_to_array(h ->> 'x-forwarded-for', ',');
    v := nullif(trim(xff[array_length(xff, 1)]), '');
  end if;
  return v;
end $$;

-- admin helper: "use the network I'm on now"
create or replace function noodle.my_ip() returns text
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
begin
  if not noodle.is_admin() then raise exception 'not allowed'; end if;
  return noodle.client_ip();
end $$;

create or replace function noodle.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
         + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- is this request allowed to clock? → {ok, reason, ip, distance_m, accuracy_m, by}
create or replace function noodle.clock_check(p_lat float8, p_lng float8, p_acc float8) returns jsonb
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare
  s jsonb := (select jsonb_object_agg(key, value) from noodle.settings where key like 'clock\_%');
  v_mode text := coalesce(s ->> 'clock_mode', 'none');
  v_ip text := noodle.client_ip();
  v_wifi boolean := false; v_loc boolean := false; v_dist float8; v_reason text;
  v_lat float8 := nullif(s ->> 'clock_lat', '')::float8;
  v_lng float8 := nullif(s ->> 'clock_lng', '')::float8;
  v_radius float8 := coalesce(nullif(s ->> 'clock_radius_m', '')::float8, 150);
  v_maxacc float8 := coalesce(nullif(s ->> 'clock_max_accuracy_m', '')::float8, 200);
begin
  if v_mode = 'none' then
    return jsonb_build_object('ok', true, 'by', 'none', 'ip', v_ip);
  end if;
  -- company network
  if v_ip is not null then
    begin
      select exists (select 1 from unnest(string_to_array(replace(coalesce(s ->> 'clock_ips', ''), ' ', ''), ',')) x
                      where x <> '' and v_ip::inet <<= x::inet) into v_wifi;
    exception when others then v_wifi := false;
    end;
  end if;
  -- location
  if p_lat is not null and p_lng is not null and v_lat is not null and v_lng is not null then
    v_dist := noodle.distance_m(p_lat, p_lng, v_lat, v_lng);
    v_loc := v_dist <= v_radius and coalesce(p_acc, 0) <= v_maxacc;
  end if;

  if (v_mode = 'wifi' and v_wifi) or (v_mode = 'location' and v_loc)
     or (v_mode = 'either' and (v_wifi or v_loc)) or (v_mode = 'both' and v_wifi and v_loc) then
    return jsonb_build_object('ok', true, 'by', case when v_wifi and v_loc then 'both' when v_wifi then 'wifi' else 'location' end,
                              'ip', v_ip, 'distance_m', round(v_dist::numeric), 'accuracy_m', round(p_acc::numeric));
  end if;

  v_reason := case
    when v_mode = 'wifi' or (v_mode = 'both' and not v_wifi) then 'not_company_network'
    when v_lat is null or v_lng is null then 'location_not_set'
    when p_lat is null or p_lng is null then 'no_location'
    when coalesce(p_acc, 0) > v_maxacc then 'location_inaccurate'
    else 'too_far' end;
  return jsonb_build_object('ok', false, 'reason', v_reason, 'ip', v_ip,
                            'distance_m', round(v_dist::numeric), 'accuracy_m', round(p_acc::numeric));
end $$;

-- current state of one employee
create or replace function noodle.clock_status_of(p_employee uuid) returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  with e as (select * from noodle.employees where id = p_employee),
       o as (select * from noodle.time_entries where employee_id = p_employee and clock_out is null),
       b as (select * from noodle.time_breaks where entry_id = (select id from o) and ends_at is null),
       today as (select (now() at time zone 'Europe/Budapest')::date d)
  select jsonb_build_object(
    'employee_id', e.id, 'name', e.name,
    'state', case when exists (select 1 from b) then 'break' when exists (select 1 from o) then 'in' else 'off' end,
    'since', coalesce((select starts_at from b), (select clock_in from o)),
    'clock_in', (select clock_in from o),
    'worked_today_min', (
      select coalesce(round(sum(extract(epoch from (coalesce(t.clock_out, now()) - t.clock_in)) / 60
                   - coalesce((select sum(extract(epoch from (coalesce(x.ends_at, now()) - x.starts_at)) / 60)
                                 from noodle.time_breaks x where x.entry_id = t.id), 0))), 0)
      from noodle.time_entries t
      where t.employee_id = e.id and (t.clock_in at time zone 'Europe/Budapest')::date = (select d from today)),
    'shifts_today', (select coalesce(jsonb_agg(jsonb_build_object('starts_at', sh.starts_at, 'ends_at', sh.ends_at, 'note', sh.note)
                                               order by sh.starts_at), '[]'::jsonb)
                     from noodle.shifts sh where sh.employee_id = e.id
                       and (sh.starts_at at time zone 'Europe/Budapest')::date = (select d from today)))
  from e
$$;

-- for the signed-in user (phone / own computer): status + which checks the UI must collect
create or replace function noodle.my_clock() returns jsonb
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
declare v uuid := noodle.my_employee_id();
begin
  return jsonb_build_object(
    'mode', coalesce((select value from noodle.settings where key = 'clock_mode'), 'none'),
    'status', case when v is null then null else noodle.clock_status_of(v) end);
end $$;

-- shared clock computer: everyone active with their state (no PINs, no hours of others beyond today)
create or replace function noodle.kiosk_board() returns jsonb
language plpgsql stable security definer set search_path = noodle, pg_temp as $$
begin
  if not (noodle.my_role() = 'kiosk' or noodle.is_staff()) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'mode', coalesce((select value from noodle.settings where key = 'clock_mode'), 'none'),
    'employees', (select coalesce(jsonb_agg(noodle.clock_status_of(e.id) || jsonb_build_object('color', e.color,
                     'has_pin', exists (select 1 from noodle.employee_pins p where p.employee_id = e.id))
                     order by e.sort, e.name), '[]'::jsonb)
                  from noodle.employees e where e.active));
end $$;

create or replace function noodle.set_employee_pin(p_employee uuid, p_pin text) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if not noodle.is_admin() then raise exception 'not allowed'; end if;
  if p_pin is null or p_pin = '' then
    delete from noodle.employee_pins where employee_id = p_employee; return;
  end if;
  if p_pin !~ '^\d{4,6}$' then raise exception 'pin must be 4-6 digits'; end if;
  insert into noodle.employee_pins(employee_id, pin_hash) values (p_employee, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (employee_id) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = null, updated_at = now();
end $$;

-- clock in / out / break. Own record (p_employee null) or, on the shared computer, an employee + PIN.
create or replace function noodle.clock_action(p_action text, p_lat float8 default null, p_lng float8 default null,
                                               p_acc float8 default null, p_employee uuid default null, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_emp uuid; v_src text; v_chk jsonb; v_open noodle.time_entries; v_pin noodle.employee_pins; v_brk uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_action not in ('in', 'out', 'break_start', 'break_end') then raise exception 'bad action'; end if;

  if p_employee is null then
    v_emp := noodle.my_employee_id(); v_src := 'self';
    if v_emp is null then raise exception 'no employee record'; end if;
  else
    if not (noodle.my_role() = 'kiosk' or noodle.is_staff()) then raise exception 'not allowed'; end if;
    if not exists (select 1 from noodle.employees where id = p_employee and active) then raise exception 'no employee record'; end if;
    select * into v_pin from noodle.employee_pins where employee_id = p_employee for update;
    if v_pin is null then raise exception 'pin not set'; end if;
    if v_pin.locked_until is not null and v_pin.locked_until > now() then raise exception 'pin locked'; end if;
    if p_pin is null or extensions.crypt(p_pin, v_pin.pin_hash) <> v_pin.pin_hash then
      update noodle.employee_pins set failed = failed + 1,
             locked_until = case when failed + 1 >= 5 then now() + interval '5 minutes' end
       where employee_id = p_employee;
      return jsonb_build_object('error', 'wrong pin');     -- returned, not raised, so the failure count is kept
    end if;
    update noodle.employee_pins set failed = 0, locked_until = null where employee_id = p_employee;
    v_emp := p_employee; v_src := 'kiosk';
  end if;

  v_chk := noodle.clock_check(p_lat, p_lng, p_acc);
  if not (v_chk ->> 'ok')::boolean then
    raise exception 'not at workplace: %', v_chk ->> 'reason';
  end if;
  v_chk := v_chk - 'ok';

  select * into v_open from noodle.time_entries where employee_id = v_emp and clock_out is null for update;
  if p_action = 'in' then
    if v_open.id is not null then raise exception 'already clocked in'; end if;
    insert into noodle.time_entries(employee_id, clock_in, source_in, check_in) values (v_emp, now(), v_src, v_chk);
  else
    if v_open.id is null then raise exception 'not clocked in'; end if;
    select id into v_brk from noodle.time_breaks where entry_id = v_open.id and ends_at is null;
    if p_action = 'break_start' then
      if v_brk is not null then raise exception 'already on break'; end if;
      insert into noodle.time_breaks(entry_id, starts_at) values (v_open.id, now());
    elsif p_action = 'break_end' then
      if v_brk is null then raise exception 'not on break'; end if;
      update noodle.time_breaks set ends_at = now() where id = v_brk;
    else -- out
      if v_brk is not null then update noodle.time_breaks set ends_at = now() where id = v_brk; end if;
      update noodle.time_entries set clock_out = now(), source_out = v_src, check_out = v_chk where id = v_open.id;
    end if;
  end if;
  return noodle.clock_status_of(v_emp);
end $$;

-- operation log
do $$
declare t text;
begin
  foreach t in array array['employees', 'time_entries', 'time_breaks', 'shifts'] loop
    execute format('drop trigger if exists audit on noodle.%I', t);
    execute format('create trigger audit after insert or update or delete on noodle.%I
                    for each row execute function noodle.audit_trigger()', t);
  end loop;
end $$;

revoke execute on all functions in schema noodle from anon, public;
revoke execute on function noodle.price_for(uuid, uuid) from authenticated;
revoke execute on function noodle.clock_check(float8, float8, float8) from authenticated;
revoke execute on function noodle.clock_status_of(uuid) from authenticated;
revoke execute on function noodle.client_ip() from authenticated;
grant execute on function noodle.public_info() to anon, authenticated;
grant execute on function noodle.my_employee_id() to authenticated;
grant execute on function noodle.my_clock() to authenticated;
grant execute on function noodle.kiosk_board() to authenticated;
grant execute on function noodle.clock_action(text, float8, float8, float8, uuid, text) to authenticated;
grant execute on function noodle.set_employee_pin(uuid, text) to authenticated;
grant execute on function noodle.my_ip() to authenticated;
grant execute on function noodle.distance_m(float8, float8, float8, float8) to authenticated;

notify pgrst, 'reload schema';
