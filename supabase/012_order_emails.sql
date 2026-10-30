-- =====================================================================
-- 012 · 订单邮件（Resend）
--   1. 客户下单 → 给外部客户发「已收到」
--   2. 工厂确认 → 给外部客户发「已确认」（员工代下单时直接是已确认，只发这一封）
--   4. 任何新订单 → 给工厂发提醒
--   内部餐厅不收客户邮件，只触发工厂提醒。
--
--   orders 触发器 → pg_net 调用 Edge Function `noodle-order-email`
--   → 函数用 service role 调 noodle.order_email_payload() 取数据（同时校验密钥）
--   → Resend 发信 → noodle.log_email() 记日志
--   Resend API key 只放在 Edge Function Secrets（RESEND_API_KEY），不进数据库。
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- shared secret between the trigger and the function (kept in Vault, never exposed to the app)
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'noodle_email_hook') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'noodle_email_hook',
                                'noodle order email trigger -> edge function');
  end if;
end $$;

-- settings (staff can read, admin can edit — same as label settings)
insert into noodle.settings (key, value) values
  ('email_mode', 'test'),                       -- off | test | live
  ('email_test_to', 'hello@101bistro.hu'),      -- in test mode every email goes only here
  ('email_factory_to', 'hello@101bistro.hu'),   -- new-order alerts (comma separated)
  ('email_factory_lang', 'hu'),                 -- hu | en | zh
  ('email_from', 'Tésztaüzem · 101 Bistro <rendeles@101bistro.hu>'),
  ('email_reply_to', 'rendeles@101bistro.hu'),
  ('app_url', 'https://noodle.101bistro.hu')
on conflict (key) do nothing;

-- log of every email attempt
create table if not exists noodle.email_log (
  id          bigint generated always as identity primary key,
  order_id    uuid references noodle.orders(id) on delete set null,
  kind        text not null,          -- received | confirmed | factory_new
  recipient   text not null,
  status      text not null,          -- sent | failed | skipped
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists email_log_order on noodle.email_log(order_id);
alter table noodle.email_log enable row level security;
drop policy if exists "email_log staff read" on noodle.email_log;
create policy "email_log staff read" on noodle.email_log for select to authenticated using (noodle.is_staff());
grant select on noodle.email_log to authenticated;

-- trigger: queue an HTTP call to the edge function (pg_net sends it after the transaction commits,
-- so the order lines written by place_order are already there)
create or replace function noodle.queue_order_email() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_event text; v_secret text;
begin
  if tg_op = 'INSERT' then v_event := 'placed';
  elsif old.status = 'submitted' and new.status = 'confirmed' then v_event := 'confirmed';
  else return new;
  end if;
  if coalesce((select value from noodle.settings where key = 'email_mode'), 'off') = 'off' then return new; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('order_id', new.id, 'event', v_event),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  -- never block an order because of email problems
  raise warning 'noodle email queue failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists orders_email on noodle.orders;
create trigger orders_email after insert or update of status on noodle.orders
  for each row execute function noodle.queue_order_email();

-- everything the function needs for one order, in one call; checks the shared secret
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
               where key like 'email\_%' or key = 'app_url'))
  into v
  from noodle.orders o join noodle.customers c on c.id = o.customer_id
  where o.id = p_order;
  return v;
end $$;

create or replace function noodle.log_email(p_secret text, p_order uuid, p_kind text, p_recipient text,
                                            p_status text, p_detail text) returns void
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if p_secret is distinct from (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  insert into noodle.email_log(order_id, kind, recipient, status, detail)
  values (p_order, p_kind, p_recipient, p_status, left(p_detail, 500));
end $$;

revoke execute on function noodle.order_email_payload(uuid, text) from public, anon, authenticated;
revoke execute on function noodle.log_email(text, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function noodle.queue_order_email() from public, anon, authenticated;
grant execute on function noodle.order_email_payload(uuid, text) to service_role;
grant execute on function noodle.log_email(text, uuid, text, text, text, text) to service_role;
grant usage on schema noodle to service_role;

notify pgrst, 'reload schema';
