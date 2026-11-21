import { useState } from 'react'
import { db, q, todayISO, supabase } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtFt, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Modal, Field, NumInput, useToast, errText } from '../components/ui'
import { invoiceHtml, invoicePdfBlob } from '../lib/invoicePdf'
import { deliverPdf } from '../lib/labelOutput'
import { hasPacking, packTextHu } from '../lib/packing'

// Month-end report: what went out, what was made, what it cost, what is left. Admins only.
const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7) }
const num = v => Number(v || 0)

export default function MonthlyReport() {
  const t = useT()
  // after the 5th the current month is the useful one; before that, the month that just ended
  const [month, setMonth] = useState(() => new Date().getDate() <= 5 ? lastMonth() : todayISO().slice(0, 7))
  const { data: r, error } = useData(() => q(db.rpc('monthly_report', { p_month: month + '-01' })), [month])
  const [invFor, setInvFor] = useState(null)
  // Excel, printing and invoices only once the month is over (from its last day): before that the numbers still change
  const closed = !!r && todayISO() >= r.to
  // invoices already generated for this month (latest per customer / store)
  const inv = useData(() => q(db.from('invoices').select('id,number,kind,customer_id,location_id,issue_date,gross,file_path,cancelled_at,created_at')
    .eq('month', month + '-01').order('created_at', { ascending: false })), [month])
  const invKey = (c, l) => c + '|' + (l || '')
  const latestInv = {}, invCount = {}, official = {}
  for (const x of inv.data || []) {
    const k = invKey(x.customer_id, x.location_id)
    if (x.kind === 'invoice') { if (!x.cancelled_at) official[k] = official[k] || x; continue }
    latestInv[k] = latestInv[k] || x; invCount[k] = (invCount[k] || 0) + 1
  }

  const k = r && (() => {
    const soldQty = r.sales_by_product.reduce((s, x) => s + num(x.qty), 0)
    const extQty = r.sales_by_product.reduce((s, x) => s + num(x.external_qty), 0)
    const sales = r.sales_by_product.reduce((s, x) => s + num(x.value), 0)
    const made = r.production.reduce((s, x) => s + num(x.actual), 0)
    const theo = r.production.reduce((s, x) => s + num(x.theoretical), 0)
    const matCost = r.materials.reduce((s, x) => s + num(x.used) * num(x.cost), 0)
    const stockValue = r.materials.reduce((s, x) => s + Math.max(num(x.end_value), 0), 0)
    return { soldQty, extQty, sales, made, loss: theo > 0 ? (1 - made / theo) * 100 : null, matCost,
             perKg: made > 0 ? matCost / made : null, bought: num(r.purchases?.value), stockValue }
  })()

  function printReport() {
    // the print stylesheet normally shows only delivery notes; this flag prints the report page instead
    document.body.classList.add('printing-report')
    const done = () => { document.body.classList.remove('printing-report'); window.removeEventListener('afterprint', done) }
    window.addEventListener('afterprint', done)
    window.print()
  }

  // real Excel file (one sheet per table), loaded only when clicked
  async function excel() {
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const kgF = '#,##0.0', ftF = '#,##0" Ft"', n3 = '#,##0.###'
    function sheet(name, head, rows, formats = [], totalRow) {
      const ws = wb.addWorksheet(name.slice(0, 31))
      ws.addRow([`${t('nav_monthReport')} · ${r.month}`]).font = { bold: true, size: 13 }
      ws.addRow([])
      const h = ws.addRow(head); h.font = { bold: true }; h.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F3' } } })
      rows.forEach(row => ws.addRow(row))
      if (totalRow) ws.addRow(totalRow).font = { bold: true }
      head.forEach((_, i) => { const col = ws.getColumn(i + 1); col.width = i ? 14 : 30; if (formats[i]) col.numFmt = formats[i] })
      ws.views = [{ state: 'frozen', ySplit: 3, xSplit: 1 }]
      return ws
    }
    sheet(t('rpSummary'), [t('name'), t('qty')], [
      [t('rpDelivered') + ' (kg)', k.soldQty], [t('rpOrders'), r.orders.delivered], [t('rpExtSales') + ' (Ft)', k.sales],
      [t('rpMade') + ' (kg)', k.made], [t('rpLoss') + ' %', k.loss != null ? Math.round(k.loss * 10) / 10 : ''],
      [t('rpMatCost') + ' (Ft)', Math.round(k.matCost)], [t('rpBoughtValue') + ' (Ft)', Math.round(k.bought)], [t('rpStockValue') + ' (Ft)', Math.round(k.stockValue)],
    ], [null, '#,##0.##'])
    const m = storeMatrix(r.sales_by_store_product)
    if (m.stores.length) sheet(t('rpByStoreProduct'), [t('customer'), ...m.prods.map(p => p.name + ' (kg)'), t('total') + ' (kg)', t('rpNetValue')],
      m.stores.map(s => [s.name, ...m.prods.map(p => s.q[p.id] || null), s.total, s.value || null]),
      [null, ...m.prods.map(() => kgF), kgF, ftF],
      [t('total'), ...m.prods.map(p => m.totals[p.id]), m.stores.reduce((a, s) => a + s.total, 0), m.stores.reduce((a, s) => a + s.value, 0)])
    sheet(t('rpSalesByCustomer'), [t('customer'), t('rpOrders'), t('qty') + ' (kg)', t('rpNetValue')],
      r.sales_by_customer.map(x => [x.name, x.orders, num(x.qty), num(x.value) || null]), [null, null, kgF, ftF])
    sheet(t('rpSalesByProduct'), [t('name'), t('rpInternal') + ' (kg)', t('rpExternal') + ' (kg)', t('qty') + ' (kg)', t('rpNetValue')],
      r.sales_by_product.map(x => [x.name, num(x.internal_qty) || null, num(x.external_qty) || null, num(x.qty), num(x.value) || null]), [null, kgF, kgF, kgF, ftF])
    sheet(t('nav_production'), [t('name'), t('batches'), t('rpActual') + ' (kg)', t('rpRecipe') + ' (kg)', t('rpLoss') + ' %'],
      r.production.map(x => [x.name, num(x.batches), num(x.actual), num(x.theoretical), x.loss_pct != null ? num(x.loss_pct) : null]), [null, '#,##0.##', kgF, kgF, '0.0'])
    sheet(t('rpMaterials'), [t('name'), t('unit'), t('rpUsed'), t('rpBought'), t('rpAdjusted'), t('rpEndStock'), t('rpEndValue')],
      r.materials.map(x => [x.name, x.unit, num(x.used), num(x.bought), num(x.adjusted), num(x.end_stock), Math.round(num(x.end_value))]), [null, null, n3, n3, n3, n3, ftF])
    sheet(t('rpProductsEnd'), [t('name'), t('rpEndStock')], r.products.map(x => [x.name + ` (${x.unit || 'kg'})`, num(x.end_stock)]), [null, n3])
    const buf = await wb.xlsx.writeBuffer()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    a.download = `teszta-havi-jelentes-${r.month}.xlsx`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  return (
    <div className="page report-page">
      <PageHead title={t('nav_monthReport')}>
        <label className="inline-field">{t('reportMonth')}
          <input type="month" value={month} max={todayISO().slice(0, 7)} onChange={e => e.target.value && setMonth(e.target.value)} /></label>
        {r && <button className="btn" disabled={!closed} title={closed ? '' : t('invAfterMonth')} onClick={printReport}>{t('print')}</button>}
        {r && <button className="btn" disabled={!closed} title={closed ? '' : t('invAfterMonth')} onClick={() => excel().catch(e => alert(e.message))}>⬇ Excel</button>}
      </PageHead>
      <ErrorBox error={error} />
      {!r ? !error && <Loading /> : (<>
        <p className="muted small">{r.from} – {r.to}</p>
        {!closed && <p className="note-box">🔒 {t('rpLocked', { d: fmtDate(r.to, t.lang) })}</p>}

        <div className="kpi-grid">
          <Kpi label={t('rpDelivered')} value={`${fmtNum(k.soldQty, t.lang)} kg`} sub={t('rpOrdersN', { n: r.orders.delivered })} />
          <Kpi label={t('rpExtSales')} value={fmtFt(k.sales)} sub={`${fmtNum(k.extQty, t.lang)} kg · ${t('rpNet')}`} />
          <Kpi label={t('rpMade')} value={`${fmtNum(k.made, t.lang)} kg`} sub={k.loss != null ? `${t('rpLoss')} ${fmtNum(Math.round(k.loss * 10) / 10, t.lang)}%` : ''} />
          <Kpi label={t('rpMatCost')} value={fmtFt(k.matCost)} sub={k.perKg != null ? `${fmtFt(k.perKg)} / kg` : ''} />
          <Kpi label={t('rpBoughtValue')} value={fmtFt(k.bought)} sub={t('rpPOsN', { n: r.purchases?.orders || 0 })} />
          <Kpi label={t('rpStockValue')} value={fmtFt(k.stockValue)} sub={t('rpAtMonthEnd')} />
        </div>
        <p className="muted small">{t('rpOrdersLine', { c: r.orders.cancelled, u: r.orders.urgent, o: r.orders.open, cu: r.orders.customers })}</p>

        <Section title={t('rpSalesByProduct')} head={[t('name'), t('rpInternal'), t('rpExternal'), t('qty'), t('rpNetValue')]}
          rows={r.sales_by_product.map(x => [x.name, kg(x.internal_qty, t), kg(x.external_qty, t), <b>{kg(x.qty, t)}</b>, fmtFt(num(x.value))])} />
        <Section title={t('rpSalesByCustomer')} head={[t('customer'), t('rpOrders'), t('qty'), t('rpNetValue')]}
          rows={r.sales_by_customer.map(x => [<>{x.name}{x.type === 'internal' && <span className="tag tag-internal">{t('internal')}</span>}</>, x.orders, kg(x.qty, t), fmtFt(num(x.value))])} />
        {(() => {
          const m = storeMatrix(r.sales_by_store_product)
          if (!m.stores.length) return null
          return <Section title={t('rpByStoreProduct')} head={[t('customer'), ...m.prods.map(p => p.name), t('total'), t('rpNetValue'), '']}
            rows={[...m.stores.map(s => [<>{s.name}{s.type === 'internal' && <span className="tag tag-internal">{t('internal')}</span>}</>,
                ...m.prods.map(p => kg(s.q[p.id], t)), <b>{kg(s.total, t)}</b>, s.value > 0 ? fmtFt(s.value) : '–',
                s.customer_id ? (() => {
                  const x = latestInv[invKey(s.customer_id, s.location_id)]
                  const o = official[invKey(s.customer_id, s.location_id)]
                  if (o) return <span className="inv-done no-print">
                    <button className="btn-link" title={t('szTitle')} onClick={() => o.file_path ? openInvoice(o).catch(e => alert(e.message)) : setInvFor(s)}>🧾 {o.number}</button>
                    <span className="muted small"> · {fmtDate(o.issue_date, t.lang)}</span>
                  </span>
                  if (!x) return closed ? <button className="btn btn-sm no-print" onClick={() => setInvFor(s)}>🧾 {t('invoiceBtn')}</button>
                    : <span className="muted small no-print">🔒 {t('invAfterMonth')}</span>
                  return <span className="inv-done no-print">
                    <button className="btn-link" title={t('invOpen')} onClick={() => openInvoice(x).catch(e => alert(e.message))}>✓ {x.number}</button>
                    <span className="muted small"> · {fmtDate(x.issue_date, t.lang)}</span>
                    {closed && <button className="btn-link small" onClick={() => setInvFor(s)}>{t('invRedo')}</button>}
                  </span>
                })() : '']),
              [<b>{t('total')}</b>, ...m.prods.map(p => <b>{kg(m.totals[p.id], t)}</b>), <b>{kg(m.stores.reduce((a, s) => a + s.total, 0), t)}</b>,
                <b>{fmtFt(m.stores.reduce((a, s) => a + s.value, 0))}</b>, '']]} />
        })()}
        <Section title={t('nav_production')} head={[t('name'), t('batches'), t('rpActual'), t('rpRecipe'), t('rpLoss')]}
          rows={r.production.map(x => [x.name, fmtNum(num(x.batches), t.lang), <b>{kg(x.actual, t)}</b>, kg(x.theoretical, t), x.loss_pct != null ? `${fmtNum(num(x.loss_pct), t.lang)}%` : '–'])} />
        <Section title={t('rpMaterials')} head={[t('name'), t('rpUsed'), t('rpBought'), t('rpAdjusted'), t('rpEndStock'), t('rpEndValue')]}
          rows={r.materials.map(x => [x.name, qu(x.used, x.unit, t), qu(x.bought, x.unit, t), qu(x.adjusted, x.unit, t),
            <b className={num(x.end_stock) < 0 ? 'neg' : ''}>{qu(x.end_stock, x.unit, t)}</b>, num(x.cost) > 0 ? fmtFt(num(x.end_value)) : <span className="muted">{t('rpNoPrice')}</span>])} />
        <Section title={t('rpProductsEnd')} head={[t('name'), t('rpEndStock')]}
          rows={r.products.map(x => [x.name, qu(x.end_stock, x.unit, t)])} />
        <p className="muted small">{t('rpNotes')}</p>
        {invFor && <InvoiceDialog store={invFor} month={r.month} from={r.from} to={r.to} onClose={() => setInvFor(null)}
          history={(inv.data || []).filter(x => x.kind !== 'invoice' && invKey(x.customer_id, x.location_id) === invKey(invFor.customer_id, invFor.location_id))}
          official={official[invKey(invFor.customer_id, invFor.location_id)]}
          onSaved={() => inv.reload()} />}
      </>)}
    </div>
  )
}

// store × product matrix from the flat rows; product columns come from the data (new products appear by themselves)
function storeMatrix(rows) {
  const prods = [], seen = {}
  for (const x of [...(rows || [])].sort((a, b) => num(a.sort) - num(b.sort))) if (!seen[x.product_id]) { seen[x.product_id] = 1; prods.push({ id: x.product_id, name: x.product, unit: x.unit }) }
  const stores = []
  const byKey = {}
  for (const x of rows || []) {
    const key = x.customer + '|' + (x.store || '')
    if (!byKey[key]) { byKey[key] = { name: x.store ? `${x.customer} · ${x.store}` : x.customer, type: x.type, customer: x.customer, store: x.store,
      customer_id: x.customer_id, location_id: x.location_id, q: {}, total: 0, value: 0 }; stores.push(byKey[key]) }
    const r = byKey[key]; r.q[x.product_id] = (r.q[x.product_id] || 0) + num(x.qty); r.total += num(x.qty); r.value += num(x.value)
  }
  const totals = Object.fromEntries(prods.map(p => [p.id, stores.reduce((s, r) => s + (r.q[p.id] || 0), 0)]))
  return { prods, stores, totals }
}

const kg = (v, t) => v == null || num(v) === 0 ? '–' : `${fmtNum(Math.round(num(v) * 10) / 10, t.lang)} kg`
const qu = (v, unit, t) => num(v) === 0 ? '–' : `${fmtNum(Math.round(num(v) * 1000) / 1000, t.lang)} ${unit || ''}`

function Kpi({ label, value, sub }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><b className="kpi-value">{value}</b>{sub && <span className="kpi-sub">{sub}</span>}</div>
}
function Section({ title, head, rows }) {
  if (!rows.length) return null
  return (
    <section className="panel report-section">
      <h2>{title}</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr>{head.map((h, i) => <th key={i} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
      </table></div>
    </section>
  )
}

/* ---------------- monthly invoice draft (díjbekérő PDF) for one customer / store ---------------- */
const INV_BUCKET = 'noodle-invoices'
async function openInvoice(x) {
  const { data, error } = await supabase.storage.from(INV_BUCKET).download(x.file_path)
  if (error) throw error
  deliverPdf(data, x.number)
}
const INV_KEYS = ['packing_bag_text', 'company_name', 'company_address', 'company_tax_no', 'company_reg_no', 'company_email', 'company_phone', 'company_bank', 'invoice_vat_rate', 'invoice_due_days']
function InvoiceDialog({ store, month, from, to, onClose, history = [], official, onSaved }) {
  const t = useT()
  const toast = useToast()
  const { data, error } = useData(async () => {
    const [settings, cust, loc, orders] = await Promise.all([
      q(db.from('settings').select('key,value').in('key', INV_KEYS)),
      q(db.from('customers').select('id,name,address,vat_no,email,phone').eq('id', store.customer_id).single()),
      store.location_id ? q(db.from('customer_locations').select('id,name,address').eq('id', store.location_id).single()) : null,
      (() => {
        let qq = db.from('orders').select('id,no,delivery_date,order_lines(qty,delivered_qty,unit_price,pack_vacuum,portion_g,vacuum_fee,portion_fee,product:products(name_hu,unit,sort))')
          .eq('customer_id', store.customer_id).eq('status', 'delivered').gte('delivery_date', from).lte('delivery_date', to).order('delivery_date')
        qq = store.location_id ? qq.eq('location_id', store.location_id) : qq.is('location_id', null)
        return q(qq)
      })(),
    ])
    return { s: Object.fromEntries(settings.map(x => [x.key, x.value])), cust, loc, orders }
  }, [store.customer_id, store.location_id, from, to])
  const [vat, setVat] = useState(null)
  const [due, setDue] = useState(null)
  const [busy, setBusy] = useState(false)
  if (error) return <Modal title={`🧾 ${store.name}`} onClose={onClose}><ErrorBox error={error} /></Modal>
  if (!data) return <Modal title={`🧾 ${store.name}`} onClose={onClose}><Loading /></Modal>
  const { s, cust, loc, orders } = data
  const vatRate = vat ?? (s.invoice_vat_rate !== undefined && s.invoice_vat_rate !== '' ? Number(s.invoice_vat_rate) : null)
  const dueDays = due ?? (Number(s.invoice_due_days) || 8)

  // group by product and price (a price change during the month gives two lines)
  const groups = {}
  for (const o of orders) for (const l of o.order_lines) {
    const qty = Number(l.delivered_qty ?? l.qty); const price = Number(l.unit_price || 0)
    const k = l.product?.name_hu + '|' + price
    groups[k] = groups[k] || { product: l.product?.name_hu, unit: l.product?.unit, sort: l.product?.sort || 0, unit_price: price, qty: 0 }
    groups[k].qty += qty
  }
  // packing fees: one line per kind and fee (kg × Ft/kg)
  for (const o of orders) for (const l of o.order_lines) {
    const qty = Number(l.delivered_qty ?? l.qty)
    for (const [kind, fee, name] of [['v', Number(l.vacuum_fee || 0), 'Vákuumcsomagolás'], ['p', Number(l.portion_fee || 0), 'Adagolás (porciózás)']]) {
      if (!(fee > 0)) continue
      const k = 'pack:' + kind + '|' + fee
      groups[k] = groups[k] || { product: name, unit: 'kg', sort: 1e6 + (kind === 'p' ? 1 : 0), unit_price: fee, qty: 0 }
      groups[k].qty += qty
    }
  }
  const lines = Object.values(groups).sort((a, b) => a.sort - b.sort || a.unit_price - b.unit_price)
  const net = lines.reduce((a, l) => a + l.qty * l.unit_price, 0)
  const noPrice = lines.some(l => !l.unit_price)
  const issue = todayISO()
  const dueDate = (() => { const d = new Date(issue + 'T12:00:00'); d.setDate(d.getDate() + dueDays); return d.toISOString().slice(0, 10) })()
  const number = `D-${month.replace('-', '')}-${String(cust.name).normalize('NFD').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase()}${loc ? '-' + String(loc.name).normalize('NFD').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() : ''}`

  async function makePdf() {
    if (vatRate === null || Number.isNaN(vatRate)) return toast(t('invNeedVat'), 'error')
    setBusy(true)
    try {
      const html = invoiceHtml({
        seller: { name: s.company_name, address: s.company_address, tax_no: s.company_tax_no, reg_no: s.company_reg_no, bank: s.company_bank, email: s.company_email, phone: s.company_phone },
        buyer: { name: cust.name, store: loc ? `${loc.name}${loc.address ? ' – ' + loc.address : ''}` : '', address: cust.address, tax_no: cust.vat_no, email: cust.email },
        number, issueDate: issue, periodFrom: from, periodTo: to, dueDate, vatRate, lines,
        deliveries: orders.map(o => ({ date: o.delivery_date, no: o.no,
          items: o.order_lines.map(l => `${l.product?.name_hu} ${new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 3 }).format(Number(l.delivered_qty ?? l.qty))} ${l.product?.unit || 'kg'}${hasPacking(l) ? ' (' + packTextHu(l, s.packing_bag_text) + ')' : ''}`).join(', ') })),
      })
      const blob = await invoicePdfBlob(html)
      // keep the file and a record, so the report shows it was made and can open it again
      const path = `${month}/${number}-${Date.now()}.pdf`
      const up = await supabase.storage.from(INV_BUCKET).upload(path, blob, { contentType: 'application/pdf', upsert: false })
      if (up.error) throw up.error
      const vatAmt = lines.reduce((a, l) => a + l.qty * l.unit_price * vatRate / 100, 0)
      await q(db.from('invoices').insert({
        number, customer_id: store.customer_id, location_id: store.location_id || null, month: month + '-01',
        period_from: from, period_to: to, issue_date: issue, due_date: dueDate, vat_rate: vatRate,
        net: Math.round(net * 100) / 100, vat: Math.round(vatAmt * 100) / 100, gross: Math.round((net + vatAmt) * 100) / 100,
        lines: lines.map(l => ({ product: l.product, unit: l.unit, qty: l.qty, unit_price: l.unit_price })), file_path: path,
      }))
      toast(t('invSaved'))
      onSaved?.()
      deliverPdf(blob, number)
      onClose()
    } catch (e) { toast(errText(e), 'error') }
    setBusy(false)
  }

  return (
    <Modal title={`🧾 ${t('invoiceBtn')} · ${store.name} · ${month}`} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{t('invHint')}</p>
        <table className="table compact">
          <thead><tr><th>{t('name')}</th><th className="num">{t('qty')}</th><th className="num">{t('invUnitPrice')}</th><th className="num">{t('rpNetValue')}</th></tr></thead>
          <tbody>{lines.map((l, i) => <tr key={i}><td>{l.product}</td><td className="num">{fmtNum(Math.round(l.qty * 1000) / 1000, t.lang)} {l.unit}</td>
            <td className={'num' + (l.unit_price ? '' : ' text-short')}>{fmtFt(l.unit_price)}</td><td className="num">{fmtFt(l.qty * l.unit_price)}</td></tr>)}</tbody>
          <tfoot><tr><td><b>{t('total')}</b></td><td /><td /><td className="num"><b>{fmtFt(net)}</b></td></tr></tfoot>
        </table>
        {noPrice && <p className="note-box short-box">⚠ {t('invNoPrice')}</p>}
        {!s.company_tax_no && <p className="note-box short-box">⚠ {t('invNoSellerTax')}</p>}
        {!cust.vat_no && <p className="muted small">{t('invNoBuyerTax')}</p>}
        <div className="form-grid">
          <Field label={t('invVat')} hint={vatRate === null ? t('invNeedVat') : t('invVatHint')}><NumInput min={0} max={27} value={vatRate} onChange={v => setVat(v)} /></Field>
          <Field label={t('invDueDays')}><NumInput min={0} max={90} value={dueDays} onChange={v => setDue(v ?? 0)} /></Field>
        </div>
        <p className="muted small">{t('invDeliveries', { n: orders.length })} · {number}</p>
        {history.length > 0 && <div className="small">
          <b>{t('invHistory')}</b>
          <ul className="inv-history">{history.map(x => <li key={x.id}>
            <button type="button" className="btn-link" onClick={() => openInvoice(x).catch(e => toast(errText(e), 'error'))}>{x.number}</button>
            {' · '}{fmtDate(x.issue_date, t.lang)} · {fmtFt(Number(x.gross))} · <span className="muted">{new Date(x.created_at).toLocaleString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          </li>)}</ul></div>}
        <SzamlazzBox store={store} month={month} vatRate={vatRate} dueDays={dueDays} dueDate={dueDate} official={official}
          onIssued={() => { onSaved?.(); onClose() }} />
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !lines.length} onClick={makePdf}>⬇ {t('szProformaPdf')}</button>
        </div>
      </div>
    </Modal>
  )
}

/* ---------------- official invoice via szamlazz.hu (edge function noodle-szamlazz) ---------------- */
async function szamlazz(body) {
  const { data, error } = await supabase.functions.invoke('noodle-szamlazz', { body })
  if (error) {
    let e = { error: error.message }
    try { e = await error.context.json() } catch { /* not JSON */ }
    const err = new Error(e.error || error.message); err.info = e; throw err
  }
  return data
}

function SzamlazzBox({ store, month, vatRate, dueDays, dueDate, official, onIssued }) {
  const t = useT()
  const toast = useToast()
  const status = useData(() => szamlazz({ action: 'status' }), [])
  const [fulfil, setFulfil] = useState(null)
  const [preview, setPreview] = useState(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const st = status.data
  const fulfilDate = fulfil ?? dueDate
  const args = { action: 'issue', customer_id: store.customer_id, location_id: store.location_id || null, month,
                 vat_rate: vatRate, due_days: dueDays, fulfillment_date: fulfilDate }
  const errMsg = e => {
    const i = e.info || {}
    if (i.error === 'already_issued') return t('szAlready', { n: i.number })
    if (i.error === 'szamlazz') return `szamlazz.hu ${i.code}: ${i.message}`
    if (i.problems) return i.problems.map(p => t('sz_' + p)).join(' · ')
    return i.error && t('sz_' + i.error) !== 'sz_' + i.error ? t('sz_' + i.error) : errText(e)
  }

  async function run(dry) {
    if (vatRate === null || Number.isNaN(vatRate)) return toast(t('invNeedVat'), 'error')
    setBusy(true)
    try {
      const r = await szamlazz({ ...args, dry_run: dry })
      if (r.demo || r.dry_run) { setPreview(r); setConfirm(false) }
      else { toast(t('szIssued', { n: r.number })); onIssued?.() }
    } catch (e) { toast(errMsg(e), 'error') }
    setBusy(false)
  }

  if (official) return (
    <div className="sz-box"><b>{t('szTitle')}</b>
      <p>✓ {t('szIssued', { n: official.number })} · {fmtDate(official.issue_date, t.lang)} · {fmtFt(Number(official.gross))}</p>
      {official.file_path && <button type="button" className="btn btn-sm" onClick={() => openInvoice(official).catch(e => toast(errText(e), 'error'))}>⬇ PDF</button>}
    </div>)

  return (
    <div className="sz-box">
      <b>{t('szTitle')}</b>
      {status.error ? <ErrorBox error={status.error} /> : !st ? <Loading /> : <>
        <p className={st.configured ? 'note-box short-box' : 'muted small'}>{st.configured ? '⚠ ' + t('szLive') : 'ℹ ' + t('szDemo')}</p>
        <div className="form-grid">
          <Field label={t('szFulfil')} hint={t('szFulfilHint')}>
            <input type="date" value={fulfilDate} onChange={e => { setFulfil(e.target.value || null); setPreview(null) }} /></Field>
        </div>
        {preview && <div className="sz-preview small">
          {preview.demo && <p><b>{t('szDemoResult')}</b></p>}
          {preview.problems?.length > 0 && <p className="note-box short-box">⚠ {preview.problems.map(p => t('sz_' + p)).join(' · ')}</p>}
          <p>{preview.einvoice ? t('szKind') : t('szPaper')} · {t('rpNet')} {fmtFt(preview.totals.net)} · ÁFA {fmtFt(preview.totals.vat)} · <b>{fmtFt(preview.totals.gross)}</b></p>
          <p className="muted">{fmtDate(preview.issue_date, t.lang)} · {t('szFulfil')}: {fmtDate(preview.fulfillment_date, t.lang)} · {t('invDueDays')}: {fmtDate(preview.due_date, t.lang)} · {preview.order_ref}</p>
          <p className="muted">{preview.send_email ? t('szEmailTo', { e: preview.xml.match(/<email>([^<]*)<\/email>/)?.[1] || '' }) : t('szNoEmail')}</p>
          <details><summary>{t('szShowXml')}</summary><pre className="sz-xml">{preview.xml.replace(/></g, '>\n<')}</pre></details>
        </div>}
        <div className="row-gap">
          <button type="button" className="btn" disabled={busy} onClick={() => run(true)}>{t('szPreview')}</button>
          {st.configured && (!confirm
            ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setConfirm(true)}>🧾 {t('szIssue')}</button>
            : <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(false)}>{t('szConfirm', { g: preview ? fmtFt(preview.totals.gross) : '' })}</button>)}
        </div>
      </>}
    </div>
  )
}
