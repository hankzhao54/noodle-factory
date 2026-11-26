// noodle-szamlazz: issues the monthly invoice of one customer / store in szamlazz.hu (Számla Agent).
// Called from the month-end report with the admin's own session (Authorization: Bearer <user JWT>).
//   status                                          → { configured, einvoice, send_email }
//   issue { customer_id, location_id, month: 'YYYY-MM', vat_rate, due_days, fulfillment_date?, dry_run? }
//     → demo / dry run: { demo: true, xml, totals, problems }  (nothing is sent)
//     → live:           { number, gross, file_path }           (invoice issued, PDF saved, row in noodle.invoices)
// The lines are worked out here from the delivered orders (not taken from the browser), plus packing fee lines.
// Secret: SZAMLAZZ_AGENT_KEY (Számla Agent key, 42 characters). Without it the function runs in demo mode.
// Settings (noodle.settings): szamlazz_einvoice ('true' / 'false'), szamlazz_send_email ('true' / 'false').
import { agentError, invoiceXml, problems, totals, type Line } from './xml.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const KEY = (Deno.env.get('SZAMLAZZ_AGENT_KEY') || '').trim()
const BUCKET = 'noodle-invoices'

// Only the noodle front-end may call this from a browser. We reflect the request's Origin
// back when it is on the allow-list, and send no CORS header otherwise.
const ALLOWED_ORIGINS = [
  'https://noodle.101bistro.hu',              // production (custom domain)
  'https://noodle-factory-gamma.vercel.app',  // production (old Vercel address, still live)
  'http://localhost:5173',                    // local dev (Vite)
]
const cors = (req: Request) => {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  const origin = req.headers.get('Origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) base['Access-Control-Allow-Origin'] = origin
  return base
}
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
const noodle = { ...svc, 'Content-Type': 'application/json', 'Accept-Profile': 'noodle', 'Content-Profile': 'noodle' }

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...noodle, ...(init.headers || {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' })
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const ascii = (s: string, n: number) => String(s).normalize('NFD').replace(/[^A-Za-z0-9]/g, '').slice(0, n).toUpperCase()
const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)

async function settings() {
  const rows: { key: string; value: string }[] = await rest(`settings?select=key,value&key=in.(company_bank,company_email,szamlazz_einvoice,szamlazz_send_email)`)
  const s = Object.fromEntries(rows.map(x => [x.key, x.value]))
  return { bank: s.company_bank || null, replyTo: s.company_email || null,
           einvoice: s.szamlazz_einvoice !== 'false', sendEmail: s.szamlazz_send_email !== 'false' }
}

Deno.serve(async req => {
  const CORS = cors(req)
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method' }, 405)

  // admins only (the month-end report is an admin page)
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: req.headers.get('Authorization') || '' } })
  if (!who.ok) return json({ error: 'not signed in' }, 401)
  const me = await who.json()
  const mine = await rest(`profiles?select=role&user_id=eq.${me.id}`)
  if (mine?.[0]?.role !== 'admin') return json({ error: 'admin only' }, 403)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'bad json' }, 400) }

  try {
    const s = await settings()
    if (body.action === 'status') return json({ configured: !!KEY, einvoice: s.einvoice, send_email: s.sendEmail })
    if (body.action !== 'issue') return json({ error: 'unknown action' }, 400)

    // ---- what to invoice ----
    const month = String(body.month || '')
    if (!/^\d{4}-\d{2}$/.test(month) || !isUuid(body.customer_id) || (body.location_id && !isUuid(body.location_id))) return json({ error: 'bad input' }, 400)
    const from = `${month}-01`
    const to = addDays(addDays(from, 32).slice(0, 7) + '-01', -1)
    if (today() < to) return json({ error: 'month_not_over' }, 400)
    const loc = body.location_id || null
    const vatRate = Number(body.vat_rate)
    const dueDays = Math.max(0, Math.min(90, Number(body.due_days ?? 8) || 0))
    const issue = today()
    const due = addDays(issue, dueDays)
    // monthly settlement: by default the fulfilment date is the payment due date (Áfa tv. 58. §); can be overridden
    const fulfil = /^\d{4}-\d{2}-\d{2}$/.test(String(body.fulfillment_date || '')) ? String(body.fulfillment_date) : due

    const [cust] = await rest(`customers?select=id,name,address,vat_no,email&id=eq.${body.customer_id}`)
    if (!cust) return json({ error: 'customer not found' }, 404)
    const store = loc ? (await rest(`customer_locations?select=id,name,address&id=eq.${loc}&customer_id=eq.${cust.id}`))[0] : null
    if (loc && !store) return json({ error: 'store not found' }, 404)

    if (!body.dry_run) {
      const done = await rest(`invoices?select=number&kind=eq.invoice&cancelled_at=is.null&customer_id=eq.${cust.id}&month=eq.${from}&location_id=${loc ? 'eq.' + loc : 'is.null'}`)
      if (done.length) return json({ error: 'already_issued', number: done[0].number }, 409)
    }

    const orders: any[] = await rest(`orders?select=no,delivery_date,order_lines(qty,delivered_qty,unit_price,vacuum_fee,portion_fee,product:products(name_hu,unit,sort))` +
      `&customer_id=eq.${cust.id}&status=eq.delivered&delivery_date=gte.${from}&delivery_date=lte.${to}` +
      `&location_id=${loc ? 'eq.' + loc : 'is.null'}&order=delivery_date`)
    // same grouping as the díjbekérő: per product and price
    const groups: Record<string, Line & { sort: number }> = {}
    for (const o of orders) for (const l of o.order_lines) {
      const qty = Number(l.delivered_qty ?? l.qty), price = Number(l.unit_price || 0)
      const k = `${l.product?.name_hu}|${price}`
      groups[k] = groups[k] || { product: l.product?.name_hu, unit: l.product?.unit, sort: l.product?.sort || 0, unit_price: price, qty: 0 }
      groups[k].qty += qty
    }
    // packing fees: one line per kind and fee (kg × Ft/kg), after the products
    for (const o of orders) for (const l of o.order_lines) {
      const qty = Number(l.delivered_qty ?? l.qty)
      for (const [kind, fee, name] of [['v', Number(l.vacuum_fee || 0), 'Vákuumcsomagolás'], ['p', Number(l.portion_fee || 0), 'Adagolás (porciózás)']] as const) {
        if (!(fee > 0)) continue
        const k = `pack:${kind}|${fee}`
        groups[k] = groups[k] || { product: name, unit: 'kg', sort: 1e6 + (kind === 'p' ? 1 : 0), unit_price: fee, qty: 0 }
        groups[k].qty += qty
      }
    }
    const lines = Object.values(groups).filter(l => l.qty !== 0).sort((a, b) => a.sort - b.sort || a.unit_price - b.unit_price)
      .map(l => ({ product: l.product, unit: l.unit, qty: Math.round(l.qty * 1000) / 1000, unit_price: l.unit_price }))

    const orderRef = `D-${month.replace('-', '')}-${ascii(cust.name, 10)}${store ? '-' + ascii(store.name, 8) : ''}`
    const inp = {
      eInvoice: s.einvoice, sendEmail: s.sendEmail, issueDate: issue, fulfillmentDate: fulfil, dueDate: due, vatRate, orderRef,
      comment: `Teljesítési időszak: ${from} – ${to}${store ? ` · ${store.name}${store.address ? ' (' + store.address + ')' : ''}` : ''} · ${orders.length} szállítás`,
      seller: { bank: s.bank, replyTo: s.replyTo },
      buyer: { name: cust.name, address: cust.address, tax_no: cust.vat_no, email: cust.email },
      lines,
    }
    const probs = problems(inp)
    const tot = totals(lines, Number.isFinite(vatRate) ? vatRate : 0)

    // demo (no key yet) or preview: show exactly what would be sent, send nothing
    if (!KEY || body.dry_run) {
      return json({ demo: !KEY, dry_run: !!body.dry_run, xml: invoiceXml({ ...inp, agentKey: KEY ? '•••' : 'SZAMLAZZ_AGENT_KEY' }),
                    totals: tot, problems: probs, lines, order_ref: orderRef, issue_date: issue, due_date: due, fulfillment_date: fulfil,
                    einvoice: s.einvoice, send_email: s.sendEmail && !!cust.email })
    }
    if (probs.length) return json({ error: 'incomplete', problems: probs }, 400)

    // ---- send to szamlazz.hu ----
    const form = new FormData()
    form.append('action-xmlagentxmlfile', new Blob([invoiceXml({ ...inp, agentKey: KEY })], { type: 'text/xml' }), 'invoice.xml')
    const r = await fetch('https://www.szamlazz.hu/szamla/', { method: 'POST', body: form })
    const err = agentError(r.headers)
    if (err || !r.ok) {
      const text = err ? '' : (await r.text()).slice(0, 300)
      return json({ error: 'szamlazz', code: err?.code ?? String(r.status), message: err?.message ?? text }, 502)
    }
    const number = r.headers.get('szlahu_szamlaszam') || ''
    const pdf = new Uint8Array(await r.arrayBuffer())
    const net = Number(r.headers.get('szlahu_nettovegosszeg') || tot.net)
    const gross = Number(r.headers.get('szlahu_bruttovegosszeg') || tot.gross)
    const url = r.headers.get('szlahu_vevoifiokurl')

    // the invoice exists now: from here on, failures must not hide its number
    let path: string | null = null
    try {
      path = `${month}/szamla-${ascii(number, 40) || Date.now()}.pdf`
      const up = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST', headers: { ...svc, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: pdf })
      if (!up.ok) { console.error('pdf upload', up.status, await up.text()); path = null }
    } catch (e) { console.error('pdf upload', e); path = null }
    try {
      await rest('invoices', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        number, kind: 'invoice', customer_id: cust.id, location_id: loc, month: from, period_from: from, period_to: to,
        issue_date: issue, due_date: due, fulfillment_date: fulfil, vat_rate: vatRate, net, vat: gross - net, gross,
        lines, file_path: path, external_id: number, external_url: url ? decodeURIComponent(url) : null,
        einvoice: s.einvoice, created_by: me.id }) })
    } catch (e) {
      console.error('invoice row', e)
      return json({ number, gross, file_path: path, warning: 'saved_in_szamlazz_only' })
    }
    return json({ number, gross, file_path: path })
  } catch (e) {
    console.error(e)
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
