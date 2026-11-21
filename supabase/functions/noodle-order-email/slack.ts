// Slack message for an order event (pure: no network). Posted to an Incoming Webhook.
import { asLang, packStr, type Lang } from './email.ts'

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
  po: ['Beszerzési rendelés', 'Purchase order', '进货单'],
  please: ['kérlek rendeld meg:', 'please order:', '请帮忙订购：'],
  needed: ['Kell ekkorra', 'Needed by', '需要到货'],
  bags: ['zsák', 'packs', '袋'],
  prod_planned: ['Gyártás tervezve', 'Production planned', '已排生产'],
  prod_done: ['Gyártás kész', 'Production done', '生产完成'],
  prod_cancelled: ['Gyártás törölve', 'Production cancelled', '生产已取消'],
  prod_undone: ['Gyártás visszavonva', 'Production undone', '生产完成已撤销'],
  batches: ['adag', 'batches', '锅'],
  expected: ['várható', 'expected', '预计'],
  lot: ['Tétel', 'Lot', '批号'],
  by: ['', 'by', '由'],
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
  const lines = (p.lines || []).map((x: any) => `• ${esc(name(x))} × ${num(Number(x.qty), l)} ${esc(x.unit)}` + (packStr(x, l) ? ` · :package: ${esc(packStr(x, l))}` : ''))
  const total = (p.lines || []).reduce((t: number, x: any) => t + Number(x.qty) * (Number(x.unit_price || 0) + Number(x.pack_fee || 0)), 0)
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

// purchase order for a supplier that is ordered via Slack (e.g. Aida)
export function buildPoSlack(p: any) {
  const s = p.settings || {}
  const l = asLang(s.slack_lang)
  const po = p.po, sup = p.supplier
  const name = (x: any) => x[`name_${l}`] || x.name_hu
  const who = sup.slack_member ? `<@${esc(sup.slack_member)}>` : esc(sup.contact || sup.name)
  const lines = (p.lines || []).map((x: any) => {
    const pack = Number(x.pack_size) || 0
    const packs = pack > 0 ? ` (${num(Number(x.qty) / pack, l)} × ${num(pack, l)} ${esc(x.unit)})` : ''
    return `• ${esc(name(x))}: *${num(Number(x.qty), l)} ${esc(x.unit)}*${packs}`
  })
  const parts = [
    `:shopping_trolley: *${tr(l, 'po')} P${po.no}* · ${who} ${tr(l, 'please')}`,
    lines.join('\n'),
    po.expected_date ? `${tr(l, 'needed')}: *${date(po.expected_date, l)}*` : '',
    po.notes ? `${tr(l, 'notes')}: ${esc(po.notes)}` : '',
    s.app_url ? `<${String(s.app_url).replace(/\/$/, '')}/purchasing|${tr(l, 'open')}>` : '',
  ].filter(Boolean)
  return { text: parts.join('\n') }
}

// production batch planned / done / cancelled / undone
export function buildProductionSlack(p: any, kind: string) {
  const s = p.settings || {}
  const l = asLang(s.slack_lang)
  const b = p.batch, pr = p.product
  const name = pr[`name_${l}`] || pr.name_hu
  const unit = esc(pr.unit || 'kg')
  const expected = Number(b.batches) * Number(pr.batch_yield || 0)
  const icon: Record<string, string> = { planned: ':clipboard:', done: ':white_check_mark:', cancelled: ':x:', undone: ':leftwards_arrow_with_hook:' }
  const head = `${icon[kind] || ':ramen:'} *${tr(l, 'prod_' + kind)} B${b.no}* · ${esc(name)} × ${num(Number(b.batches), l)} ${tr(l, 'batches')}`
  let detail = ''
  if (kind === 'done' && b.actual_qty != null) {
    const diff = expected > 0 ? (Number(b.actual_qty) - expected) / expected * 100 : null
    detail = `*${num(Number(b.actual_qty), l)} ${unit}*` +
      (expected > 0 ? ` (${tr(l, 'expected')} ${num(Math.round(expected * 10) / 10, l)} ${unit}${diff != null ? `, ${diff >= 0 ? '+' : ''}${num(Math.round(diff * 10) / 10, l)}%` : ''})` : '') +
      (b.lot_no ? ` · ${tr(l, 'lot')} ${esc(b.lot_no)}` : '')
  } else if (expected > 0) {
    detail = `≈ ${num(Math.round(expected * 10) / 10, l)} ${unit} · ${date(b.planned_date, l)}`
  } else detail = date(b.planned_date, l)
  const parts = [
    head,
    detail,
    b.by ? `${tr(l, 'by')} ${esc(b.by)}`.trim() : '',
    b.notes ? `${tr(l, 'notes')}: ${esc(b.notes)}` : '',
    s.app_url ? `<${String(s.app_url).replace(/\/$/, '')}/production|${tr(l, 'open')}>` : '',
  ].filter(Boolean)
  return { text: parts.join('\n') }
}
