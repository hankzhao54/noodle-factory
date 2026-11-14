-- =====================================================================
-- 037 · 通过 Slack 下的进货单（例如碳酸钠：发消息给 Aida）
--   suppliers.order_via = 'slack' + slack_member (Slack member ID, e.g. U012ABCDEF, to @-mention).
--   When a purchase order for such a supplier is marked "ordered", the order goes to the Slack
--   channel (same webhook as the order notifications), mentioning that person.
--   Supplier "Aida (Slack)" is created and set as the default supplier of sodium carbonate.
-- =====================================================================
alter table noodle.suppliers add column if not exists order_via text not null default 'other';
alter table noodle.suppliers drop constraint if exists suppliers_order_via_check;
alter table noodle.suppliers add constraint suppliers_order_via_check check (order_via in ('other', 'email', 'slack'));
alter table noodle.suppliers add column if not exists slack_member text;

-- payload for the edge function (checked with the hook secret, like order_email_payload)
create or replace function noodle.po_slack_payload(p_po uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v jsonb;
begin
  if p_secret is null or p_secret is distinct from
     (select decrypted_secret from vault.decrypted_secrets where name = 'noodle_email_hook') then
    raise exception 'bad hook secret';
  end if;
  select jsonb_build_object(
    'po', jsonb_build_object('id', po.id, 'no', po.no, 'expected_date', po.expected_date, 'notes', po.notes),
    'supplier', jsonb_build_object('name', s.name, 'contact', s.contact, 'slack_member', s.slack_member),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                 'name_hu', m.name_hu, 'name_en', m.name_en, 'name_zh', m.name_zh, 'unit', m.unit,
                 'qty', l.qty, 'pack_size', m.pack_size) order by m.name_hu)
               from noodle.purchase_order_lines l join noodle.materials m on m.id = l.material_id
               where l.po_id = po.id), '[]'::jsonb),
    'settings', (select jsonb_object_agg(key, value) from noodle.settings where key like 'slack\_%' or key = 'app_url'))
  into v
  from noodle.purchase_orders po join noodle.suppliers s on s.id = po.supplier_id
  where po.id = p_po;
  return v;
end $$;

create or replace function noodle.queue_po_slack() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
declare v_secret text;
begin
  if new.status <> 'ordered' or old.status is not distinct from 'ordered' then return new; end if;
  if coalesce((select order_via from noodle.suppliers where id = new.supplier_id), '') <> 'slack' then return new; end if;
  if coalesce((select value from noodle.settings where key = 'slack_mode'), 'off') = 'off' then return new; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'noodle_email_hook';
  perform net.http_post(
    url := 'https://fuqkjwfbwtnkukxoytfj.supabase.co/functions/v1/noodle-order-email',
    body := jsonb_build_object('po_id', new.id, 'event', 'purchase'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-noodle-hook', v_secret),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  raise warning 'noodle purchase slack failed: %', sqlerrm;
  return new;
end $$;
drop trigger if exists purchase_orders_slack on noodle.purchase_orders;
create trigger purchase_orders_slack after update of status on noodle.purchase_orders
  for each row execute function noodle.queue_po_slack();

insert into noodle.suppliers (name, contact, notes, order_via, active)
select 'Aida (Slack)', 'Aida', 'Rendelés Slacken keresztül Aidának.', 'slack', true
 where not exists (select 1 from noodle.suppliers where name = 'Aida (Slack)');
update noodle.materials set default_supplier_id = (select id from noodle.suppliers where name = 'Aida (Slack)')
 where code = 'M-E500I';

revoke execute on function noodle.po_slack_payload(uuid, text) from public, anon, authenticated;
grant execute on function noodle.po_slack_payload(uuid, text) to service_role;
revoke execute on function noodle.queue_po_slack() from public, anon, authenticated;
notify pgrst, 'reload schema';
