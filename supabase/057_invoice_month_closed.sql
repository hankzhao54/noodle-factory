-- =====================================================================
-- 057 · 发票只能在月底以后生成（当月最后一天起），避免数字还在变时开票
-- =====================================================================
create or replace function noodle.invoice_month_closed() returns trigger
language plpgsql security definer set search_path = noodle, pg_temp as $$
begin
  if new.period_to > (now() at time zone 'Europe/Budapest')::date then
    raise exception 'month not over yet: invoices can be made from %', to_char(new.period_to, 'YYYY-MM-DD');
  end if;
  return new;
end $$;
revoke execute on function noodle.invoice_month_closed() from public, anon, authenticated;
drop trigger if exists month_closed on noodle.invoices;
create trigger month_closed before insert on noodle.invoices for each row execute function noodle.invoice_month_closed();
