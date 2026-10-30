// Builds the order emails (pure: no network), so it can be tested locally.
// kinds: received (customer, order placed), confirmed (customer), factory_new (factory alert)

export type Lang = 'hu' | 'en' | 'zh'
export interface Mail { kind: string; to: string[]; subject: string; html: string; text: string }

const T: Record<string, [string, string, string]> = {
  // [hu, en, zh]
  received_subject: ['Rendelését megkaptuk – #{no}', 'We received your order – #{no}', '已收到您的订单 – #{no}'],
  received_intro: ['Köszönjük rendelését! Megkaptuk, hamarosan visszaigazoljuk.',
    'Thank you for your order! We have received it and will confirm it shortly.',
    '感谢您的订购！我们已收到订单，确认后会再通知您。'],
  confirmed_subject: ['Rendelés visszaigazolva – #{no}', 'Order confirmed – #{no}', '订单已确认 – #{no}'],
  confirmed_intro: ['Rendelését visszaigazoltuk, a megadott napon szállítjuk.',
    'Your order is confirmed and will be delivered on the date below.',
    '您的订单已确认，将在以下日期送达。'],
  factory_subject: ['Új rendelés #{no} – {customer} – szállítás {date}', 'New order #{no} – {customer} – delivery {date}',
    '新订单 #{no} – {customer} – 送货 {date}'],
  factory_intro: ['Új rendelés érkezett.', 'A new order has come in.', '有新订单。'],
  order_no: ['Rendelésszám', 'Order no.', '订单号'],
  customer: ['Ügyfél', 'Customer', '客户'],
  delivery_date: ['Szállítás napja', 'Delivery date', '送货日期'],
  address: ['Cím', 'Address', '地址'],
  status: ['Állapot', 'Status', '状态'],
  product: ['Termék', 'Product', '产品'],
  qty: ['Mennyiség', 'Quantity', '数量'],
  price: ['Egységár', 'Unit price', '单价'],
  total: ['Összesen', 'Total', '合计'],
  net: ['nettó', 'net', '不含税'],
  notes: ['Megjegyzés', 'Notes', '备注'],
  st_submitted: ['Visszaigazolásra vár', 'Waiting for confirmation', '待确认'],
  st_confirmed: ['Visszaigazolva', 'Confirmed', '已确认'],
  internal: ['saját étterem', 'own restaurant', '自家餐厅'],
  open: ['Megnyitás', 'Open', '打开'],
  view_orders: ['Rendeléseim megtekintése', 'View my orders', '查看我的订单'],
  invoice_note: ['Fizetés: számla a kiszállítás után.', 'Payment: invoice after delivery.', '付款：送货后开发票。'],
  reply_note: ['Kérdés esetén válaszoljon erre az e-mailre.', 'If you have any questions, just reply to this email.',
    '如有问题，请直接回复此邮件。'],
  test_banner: ['TESZT – eredeti címzett: {to}', 'TEST – original recipient: {to}', '测试 – 原收件人：{to}'],
}
const IDX: Record<Lang, number> = { hu: 0, en: 1, zh: 2 }
const tr = (lang: Lang, key: string, vars: Record<string, string | number> = {}) =>
  T[key][IDX[lang]].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
export const asLang = (x: unknown): Lang => (x === 'en' || x === 'zh' || x === 'hu' ? x : 'hu')

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function fmtNum(n: number, lang: Lang) {
  return new Intl.NumberFormat(lang === 'hu' ? 'hu-HU' : lang === 'zh' ? 'zh-CN' : 'en-GB',
    { maximumFractionDigits: 3 }).format(n)
}
function fmtFt(n: number, _lang: Lang) {
  return new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' Ft'
}
function fmtDate(iso: string, lang: Lang) {
  const [y, m, d] = iso.split('-').map(Number)
  if (lang === 'hu') return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}.`
  if (lang === 'zh') return `${y}年${m}月${d}日`
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
const pickName = (l: any, lang: Lang) =>
  (lang === 'zh' ? l.name_zh : lang === 'en' ? l.name_en : l.name_hu) || l.name_hu || l.name_en || l.name_zh || '–'

export const splitEmails = (s: unknown): string[] =>
  String(s ?? '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))

function render(p: any, lang: Lang, kind: string, showPrices: boolean): { html: string; text: string } {
  const o = p.order, c = p.customer, lines: any[] = p.lines || []
  const app = String(p.settings?.app_url || '').replace(/\/$/, '')
  const intro = tr(lang, kind === 'received' ? 'received_intro' : kind === 'confirmed' ? 'confirmed_intro' : 'factory_intro')
  const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price || 0), 0)
  const hasPrices = showPrices && lines.some(l => Number(l.unit_price) > 0)
  const custLabel = c.name + (c.type === 'internal' ? ` (${tr(lang, 'internal')})` : '')

  const facts: [string, string][] = [
    [tr(lang, 'order_no'), `#${o.no}`],
    [tr(lang, 'customer'), custLabel],
    [tr(lang, 'delivery_date'), fmtDate(o.delivery_date, lang)],
  ]
  if (c.address) facts.push([tr(lang, 'address'), c.address])
  if (kind === 'factory_new') facts.push([tr(lang, 'status'), tr(lang, o.status === 'confirmed' ? 'st_confirmed' : 'st_submitted')])

  const td = 'padding:8px 10px;border-bottom:1px solid #e5e7e4;'
  const rows = lines.map(l => `<tr>
      <td style="${td}">${esc(pickName(l, lang))}</td>
      <td style="${td}text-align:right;white-space:nowrap">${esc(fmtNum(Number(l.qty), lang))} ${esc(l.unit)}</td>
      ${hasPrices ? `<td style="${td}text-align:right;white-space:nowrap">${esc(fmtFt(Number(l.unit_price || 0), lang))}</td>` : ''}
    </tr>`).join('')
  const link = kind === 'factory_new' ? `${app}/orders` : app
  const linkLabel = tr(lang, kind === 'factory_new' ? 'open' : 'view_orders')

  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#1e2a2f">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border:1px solid #e5e7e4;border-radius:10px;padding:24px">
      <div style="font-weight:bold;font-size:18px;margin-bottom:16px">Tésztaüzem · 101 Bistro</div>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.5">${esc(intro)}</p>
      <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">
        ${facts.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#5b6770">${esc(k)}</td><td style="padding:3px 0;font-weight:bold">${esc(v)}</td></tr>`).join('')}
      </table>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr style="background:#f7f8f6">
          <th style="${td}text-align:left">${esc(tr(lang, 'product'))}</th>
          <th style="${td}text-align:right">${esc(tr(lang, 'qty'))}</th>
          ${hasPrices ? `<th style="${td}text-align:right">${esc(tr(lang, 'price'))}</th>` : ''}
        </tr></thead>
        <tbody>${rows}</tbody>
        ${hasPrices ? `<tfoot><tr><td style="padding:10px;font-weight:bold" colspan="2">${esc(tr(lang, 'total'))} (${esc(tr(lang, 'net'))})</td>
          <td style="padding:10px;text-align:right;font-weight:bold;white-space:nowrap">${esc(fmtFt(total, lang))}</td></tr></tfoot>` : ''}
      </table>
      ${o.notes ? `<p style="margin:16px 0 0;font-size:14px"><span style="color:#5b6770">${esc(tr(lang, 'notes'))}:</span> ${esc(o.notes)}</p>` : ''}
      ${app ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1e2a2f;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px">${esc(linkLabel)}</a></p>` : ''}
      ${kind !== 'factory_new' ? `<p style="margin:20px 0 0;font-size:13px;color:#5b6770">${esc(tr(lang, 'invoice_note'))} ${esc(tr(lang, 'reply_note'))}</p>` : ''}
    </div>
  </div></body></html>`

  const text = [
    intro, '',
    ...facts.map(([k, v]) => `${k}: ${v}`), '',
    ...lines.map(l => `- ${pickName(l, lang)}: ${fmtNum(Number(l.qty), lang)} ${l.unit}` +
      (hasPrices ? ` × ${fmtFt(Number(l.unit_price || 0), lang)}` : '')),
    ...(hasPrices ? ['', `${tr(lang, 'total')} (${tr(lang, 'net')}): ${fmtFt(total, lang)}`] : []),
    ...(o.notes ? ['', `${tr(lang, 'notes')}: ${o.notes}`] : []),
    ...(app ? ['', `${linkLabel}: ${link}`] : []),
    ...(kind !== 'factory_new' ? ['', tr(lang, 'invoice_note'), tr(lang, 'reply_note')] : []),
  ].join('\n')
  return { html, text }
}

// event: 'placed' (order inserted) | 'confirmed' (submitted -> confirmed)
export function buildEmails(p: any, event: string): Mail[] {
  const out: Mail[] = []
  const s = p.settings || {}
  const sent = new Set<string>(p.sent || [])
  const o = p.order, c = p.customer
  const vars = (lang: Lang) => ({ no: o.no, customer: c.name, date: fmtDate(o.delivery_date, lang) })

  // customer emails: external customers only (own restaurants don't get them)
  if (c.type !== 'internal') {
    let kind: string | null = null
    if (event === 'placed') kind = o.status === 'confirmed' ? 'confirmed' : 'received'
    if (event === 'confirmed') kind = 'confirmed'
    if (kind && !sent.has(kind)) {
      const to = [...new Set([...splitEmails(c.email), ...(p.accounts || []).flatMap((a: any) => splitEmails(a.email))])]
      const lang = asLang((p.accounts || []).find((a: any) => a.lang)?.lang)
      if (to.length) {
        const { html, text } = render(p, lang, kind, true)
        out.push({ kind, to, subject: tr(lang, kind === 'received' ? 'received_subject' : 'confirmed_subject', vars(lang)), html, text })
      }
    }
  }

  // factory alert on every new order
  if (event === 'placed' && !sent.has('factory_new')) {
    const to = splitEmails(s.email_factory_to)
    const lang = asLang(s.email_factory_lang)
    if (to.length) {
      const { html, text } = render(p, lang, 'factory_new', true)
      out.push({ kind: 'factory_new', to, subject: tr(lang, 'factory_subject', vars(lang)), html, text })
    }
  }

  // test mode: everything goes only to the test address, with the original recipient noted
  if (s.email_mode === 'test') {
    const testTo = splitEmails(s.email_test_to)
    return out.filter(() => testTo.length).map(m => {
      const banner = tr('en', 'test_banner', { to: m.to.join(', ') })
      return {
        ...m, to: testTo, subject: `[TEST] ${m.subject}`,
        html: m.html.replace(
          '<div style="max-width:560px;margin:0 auto;padding:24px 16px">',
          `<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff3cd;border:1px solid #f0d58a;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px">${esc(banner)}</div>`),
        text: `${banner}\n\n${m.text}`,
      }
    })
  }
  if (s.email_mode !== 'live') return []
  // live: never email addresses on the block list (e.g. test accounts)
  const blocked = new Set(splitEmails(s.email_block))
  return out.map(m => ({ ...m, to: m.to.filter(x => !blocked.has(x)) })).filter(m => m.to.length)
}
