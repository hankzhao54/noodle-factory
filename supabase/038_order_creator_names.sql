-- =====================================================================
-- 038 · 订单显示下单人
--   staff_user_names(ids): name (or e-mail) of the accounts that placed orders; staff only.
-- =====================================================================
create or replace function noodle.staff_user_names(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = noodle, pg_temp as $$
  select case when noodle.is_staff() then coalesce(jsonb_object_agg(u.id, coalesce(nullif(p.display_name, ''), u.email)), '{}'::jsonb) else '{}'::jsonb end
  from auth.users u left join noodle.profiles p on p.user_id = u.id
  where u.id = any (p_ids)
$$;
revoke execute on function noodle.staff_user_names(uuid[]) from public, anon;
grant execute on function noodle.staff_user_names(uuid[]) to authenticated;
notify pgrst, 'reload schema';
