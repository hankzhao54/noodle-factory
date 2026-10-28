-- 005 · 新账号默认匈牙利语
alter table noodle.profiles alter column lang set default 'hu';
create or replace function noodle.request_access(p_name text, p_company text, p_phone text, p_lang text default 'hu')
returns noodle.profiles
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare r noodle.profiles;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into noodle.profiles(user_id, display_name, company, phone, lang)
  values (auth.uid(), p_name, p_company, p_phone, coalesce(p_lang,'hu'))
  on conflict (user_id) do update
     set display_name = excluded.display_name,
         company      = excluded.company,
         phone        = excluded.phone
     where noodle.profiles.role = 'pending'
  returning * into r;
  if r.user_id is null then select * into r from noodle.profiles where user_id = auth.uid(); end if;
  return r;
end $$;
-- 现有的测试账号也改成匈牙利语
update noodle.profiles set lang = 'hu' where user_id in (select id from auth.users where email like '%@test.local');
