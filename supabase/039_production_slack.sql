-- =====================================================================
-- 039 · 生产推送到 Slack（和订单一样，发到订单通知频道）
--   Only when a batch is finished: "Production done" with actual kg, lot and the difference to the
--   recipe yield. Only when slack_mode is on.
-- =====================================================================
create or replace function noodle.production_slack_payload(p_batch uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v jsonb;
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  select jsonb_build_object(
    'batch', jsonb_build_object('id', b.id, 'no', b.no, 'status', b.status, 'batches', b.batches,
                                'planned_date', b.planned_date, 'actual_qty', b.actual_qty, 'lot_no', b.lot_no, 'notes', b.notes,
                                'by', (select coalesce(nullif(p.display_name, ''), u.email) from auth.users u
                                         left join noodle.profiles p on p.user_id = u.id where u.id = coalesce(auth.uid(), b.created_by))),
    'product', jsonb_build_object('name_hu', pr.name_hu, 'name_en', pr.name_en, 'name_zh', pr.name_zh, 'unit', pr.unit,
                                  'batch_yield', pr.batch_yield),
    'settings', (select jsonb_object_agg(key, value) from noodle.settings where key like 'slack\_%' or key = 'app_url'))
  into v
  from noodle.production_batches b join noodle.products pr on pr.id = b.product_id
  where b.id = p_batch;
  return v;
end $$;

create or replace function noodle.queue_production_slack() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_kind text; v_secret text;
begin
  -- only when a batch is finished
  if not (old.status = 'planned' and new.status = 'done') then return new; end if;
  v_kind := 'done';
  if coalesce((select value from noodle.settings where key = 'slack_mode'), 'off') = 'off' then return new; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('batch_id', new.id, 'event', 'production', 'kind', v_kind,
              'by', (select coalesce(nullif(p.display_name, ''), u.email) from auth.users u
                       left join noodle.profiles p on p.user_id = u.id where u.id = auth.uid())),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  raise warning 'noodle production slack failed: %', sqlerrm;
  return new;
end $$;
drop trigger if exists production_batches_slack on noodle.production_batches;
create trigger production_batches_slack after update of status on noodle.production_batches
  for each row execute function noodle.queue_production_slack();

revoke execute on function noodle.production_slack_payload(uuid, text) from public, anon, authenticated;
grant execute on function noodle.production_slack_payload(uuid, text) to service_role;
revoke execute on function noodle.queue_production_slack() from public, anon, authenticated;
notify pgrst, 'reload schema';
