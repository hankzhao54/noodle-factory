// Slack message for an order event (pure: no network). Posted to an Incoming Webhook.
import { asLang, type Lang } from './email.ts'

const T: Record<string, [string, string, string]> = {
  placed: ['Új rendelés', 'New order', '新订单'],
  cancelled: ['Rendelés lemondva', 'Order cancelled', '订单已取消'],
  changed: ['Rendelés módosítva', 'Order changed', '订单已修改'],
  delivery: ['Szállítás', 'Delivery', '送货'],
  submitted: ['visszaigazolásra vár', 'waiting for confirmation', '待确认'],
  confirmed: ['visszaigazolva', 'confirmed', '已确认'],
  internal: ['saját étterem', 'own restaurant', '自家餐厅'],
  wholesale: ['külső ügyfél', 'external customer', '外部客户'],
  total: ['Összesen', 'Total', '合计'],
  net: ['nettó', 'net', '不含税'],
  notes: ['Megjegyzés', 'Notes', '备注'],
  open: ['Megnyitás a háttérrendszerben', 'Open in the back office', '在后台打开'],
  urgent: ['SÜRGŐS', 'URGENT', '紧急'],
  test: ['Teszt: a Slack értesítések működnek ✅', 'Test: Slack notifications are working ✅', '测试：Slack 推送设置成功 ✅'],
}
const IDX: Record<Lang, number> = { hu: 0, en: 1, zh: 2 }
const tr = (l: Lang, k: string) => T[k][IDX[l]]

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const num = (n: number, l: Lang) => new Intl.NumberFormat(l === 'hu' ? 'hu-HU' : l === 'zh' ? 'zh-CN' : 'en-GB', { maximumFractionDigits: 3 }).format(n)
const ft = (n: number) => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' Ft'
function date(iso: string, l: Lang) {
  const d = new Date(iso + 'T12:00:00Z')
  return d.toLocaleDateString(l === 'hu' ? 'hu-HU' : l === 'zh' ? 'zh-CN' : 'en-GB',
    { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' })
}

export function slackTest(settings: any) {
  const l = asLang(settings?.slack_lang)
  return { text: tr(l, 'test') }
}

export function buildSlack(p: any, event: string, detail?: string) {
  const s = p.settings || {}
  const l = asLang(s.slack_lang)
  const o = p.order, c = p.customer
  const name = (x: any) => x[`name_${l}`] || x.name_hu
  const internal = c.type === 'internal'
  const head = event === 'cancelled'
    ? `:x: *${tr(l, 'cancelled')} #${o.no}* · ${esc(c.name)}`
    : event === 'changed'
      ? `:pencil2: *${tr(l, 'changed')} #${o.no}* · ${esc(c.name)}`
      : `:ramen: *${tr(l, 'placed')} #${o.no}* · ${esc(c.name)} (${tr(l, internal ? 'internal' : 'wholesale')})`
  const urgent = o.urgent && event !== 'cancelled' ? `:rotating_light: *${tr(l, 'urgent')}* ` : ''
  const lines = (p.lines || []).map((x: any) => `• ${esc(name(x))} × ${num(Number(x.qty), l)} ${esc(x.unit)}`)
  const total = (p.lines || []).reduce((t: number, x: any) => t + Number(x.qty) * Number(x.unit_price || 0), 0)
  const parts = [
    urgent + head,
    `${tr(l, 'delivery')}: *${date(o.delivery_date, l)}*` + (event === 'placed' ? ` · ${tr(l, o.status === 'confirmed' ? 'confirmed' : 'submitted')}` : ''),
    event === 'changed' && detail ? esc(detail) : '',
    event === 'placed' || event === 'changed' ? lines.join('\n') : '',
    event === 'placed' && !internal && total > 0 ? `${tr(l, 'total')}: ${ft(total)} ${tr(l, 'net')}` : '',
    o.notes ? `${tr(l, 'notes')}: ${esc(o.notes)}` : '',
    s.app_url ? `<${String(s.app_url).replace(/\/$/, '')}/orders|${tr(l, 'open')}>` : '',
  ].filter(Boolean)
  return { text: parts.join('\n') }
}
