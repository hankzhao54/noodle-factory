-- =====================================================================
-- 018 · Slack 新订单推送
--   The same trigger + edge function as the order emails. Slack is used when slack_mode = 'on'
--   and the edge function has the secret SLACK_WEBHOOK_URL (an Incoming Webhook for one channel).
--   Events: placed (new order), cancelled. Emails are unchanged.
-- =====================================================================
insert into noodle.settings (key, value) values
  ('slack_mode', 'off'),
  ('slack_lang', 'en')
on conflict (key) do nothing;

create or replace function noodle.queue_order_email() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_event text; v_secret text;
begin
  if tg_op = 'INSERT' then v_event := 'placed';
  elsif old.status = 'submitted' and new.status = 'confirmed' then v_event := 'confirmed';
  elsif old.status is distinct from 'cancelled' and new.status = 'cancelled' then v_event := 'cancelled';
  else return new;
  end if;
  if coalesce((select value from noodle.settings where key = 'email_mode'), 'off') = 'off'
     and coalesce((select value from noodle.settings where key = 'slack_mode'), 'off') = 'off' then return new; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('order_id', new.id, 'event', v_event),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  raise warning 'noodle notification queue failed: %', sqlerrm;
  return new;
end $$;

-- payload: same as 012, settings now include slack_*
create or replace function noodle.order_email_payload(p_order uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v jsonb;
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  select jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'no', o.no, 'status', o.status, 'delivery_date', o.delivery_date,
                                'notes', o.notes, 'created_at', o.created_at),
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type, 'email', c.email,
                                   'address', c.address, 'phone', c.phone, 'contact_person', c.contact_person),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                 'name_hu', p.name_hu, 'name_en', p.name_en, 'name_zh', p.name_zh, 'unit', p.unit,
                 'qty', l.qty, 'unit_price', l.unit_price) order by p.sort, p.name_hu)
               from noodle.order_lines l join noodle.products p on p.id = l.product_id
               where l.order_id = o.id), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', pr.lang))
               from noodle.profiles pr join auth.users u on u.id = pr.user_id
               where pr.customer_id = c.id and pr.role in ('customer', 'restaurant')), '[]'::jsonb),
    'sent', coalesce((select jsonb_agg(distinct kind) from noodle.email_log
               where order_id = o.id and status = 'sent'), '[]'::jsonb),
    'settings', (select jsonb_object_agg(key, value) from noodle.settings
               where key like 'email\_%' or key like 'slack\_%' or key = 'app_url'))
  into v
  from noodle.orders o join noodle.customers c on c.id = o.customer_id
  where o.id = p_order;
  return v;
end $$;

-- settings for the Slack test message (no order); same secret check
create or replace function noodle.notify_settings(p_secret text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  return (select jsonb_object_agg(key, value) from noodle.settings where key like 'slack\_%' or key = 'app_url');
end $$;

-- admin button: send a test message to Slack
create or replace function noodle.slack_test() returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_secret text;
begin
  if not noodle.is_admin() then raise exception 'not allowed'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('event', 'slack_test'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
end $$;


revoke execute on function noodle.order_email_payload(uuid, text) from public, anon, authenticated;
revoke execute on function noodle.notify_settings(text) from public, anon, authenticated;
revoke execute on function noodle.queue_order_email() from public, anon, authenticated;
revoke execute on function noodle.slack_test() from public, anon;
grant execute on function noodle.order_email_payload(uuid, text) to service_role;
grant execute on function noodle.notify_settings(text) to service_role;
grant execute on function noodle.slack_test() to authenticated;

notify pgrst, 'reload schema';
