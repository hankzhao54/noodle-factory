-- =====================================================================
-- 024 · 取消打卡 / 排班（撤销 021）
-- =====================================================================
drop function if exists noodle.clock_action(text, float8, float8, float8, uuid, text);
drop function if exists noodle.kiosk_board();
drop function if exists noodle.my_clock();
drop function if exists noodle.clock_status_of(uuid);
drop function if exists noodle.clock_check(float8, float8, float8);
drop function if exists noodle.set_employee_pin(uuid, text);
drop function if exists noodle.my_ip();
drop function if exists noodle.client_ip();
drop function if exists noodle.distance_m(float8, float8, float8, float8);
drop table if exists noodle.time_breaks, noodle.time_entries, noodle.shifts, noodle.employee_pins cascade;
drop table if exists noodle.employees cascade;
drop function if exists noodle.my_employee_id();
delete from noodle.settings where key like 'clock\_%';

update noodle.profiles set role = 'pending' where role in ('worker', 'kiosk');
alter table noodle.profiles drop constraint if exists profiles_role_check;
alter table noodle.profiles add constraint profiles_role_check
  check (role in ('admin', 'staff', 'customer', 'restaurant', 'pending'));
notify pgrst, 'reload schema';
