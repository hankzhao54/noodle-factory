import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtFt } from '../lib/i18n'
import { Loading, ErrorBox, PageHead } from '../components/ui'

// Month-end report: what went out, what was made, what it cost, what is left. Admins only.
const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7) }
const num = v => Number(v || 0)

export default function MonthlyReport() {
  const t = useT()
  // after the 5th the current month is the useful one; before that, the month that just ended
  const [month, setMonth] = useState(() => new Date().getDate() <= 5 ? lastMonth() : todayISO().slice(0, 7))
  const { data: r, error } = useData(() => q(db.rpc('monthly_report', { p_month: month + '-01' })), [month])

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
        {r && <button className="btn" onClick={printReport}>{t('print')}</button>}
        {r && <button className="btn" onClick={() => excel().catch(e => alert(e.message))}>⬇ Excel</button>}
      </PageHead>
      <ErrorBox error={error} />
      {!r ? !error && <Loading /> : (<>
        <p className="muted small">{r.from} – {r.to}{month === todayISO().slice(0, 7) ? ` · ${t('rpMonthRunning')}` : ''}</p>

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
          return <Section title={t('rpByStoreProduct')} head={[t('customer'), ...m.prods.map(p => p.name), t('total'), t('rpNetValue')]}
            rows={[...m.stores.map(s => [<>{s.name}{s.type === 'internal' && <span className="tag tag-internal">{t('internal')}</span>}</>,
                ...m.prods.map(p => kg(s.q[p.id], t)), <b>{kg(s.total, t)}</b>, s.value > 0 ? fmtFt(s.value) : '–']),
              [<b>{t('total')}</b>, ...m.prods.map(p => <b>{kg(m.totals[p.id], t)}</b>), <b>{kg(m.stores.reduce((a, s) => a + s.total, 0), t)}</b>,
                <b>{fmtFt(m.stores.reduce((a, s) => a + s.value, 0))}</b>]]} />
        })()}
        <Section title={t('nav_production')} head={[t('name'), t('batches'), t('rpActual'), t('rpRecipe'), t('rpLoss')]}
          rows={r.production.map(x => [x.name, fmtNum(num(x.batches), t.lang), <b>{kg(x.actual, t)}</b>, kg(x.theoretical, t), x.loss_pct != null ? `${fmtNum(num(x.loss_pct), t.lang)}%` : '–'])} />
        <Section title={t('rpMaterials')} head={[t('name'), t('rpUsed'), t('rpBought'), t('rpAdjusted'), t('rpEndStock'), t('rpEndValue')]}
          rows={r.materials.map(x => [x.name, qu(x.used, x.unit, t), qu(x.bought, x.unit, t), qu(x.adjusted, x.unit, t),
            <b className={num(x.end_stock) < 0 ? 'neg' : ''}>{qu(x.end_stock, x.unit, t)}</b>, num(x.cost) > 0 ? fmtFt(num(x.end_value)) : <span className="muted">{t('rpNoPrice')}</span>])} />
        <Section title={t('rpProductsEnd')} head={[t('name'), t('rpEndStock')]}
          rows={r.products.map(x => [x.name, qu(x.end_stock, x.unit, t)])} />
        <p className="muted small">{t('rpNotes')}</p>
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
    if (!byKey[key]) { byKey[key] = { name: x.store ? `${x.customer} · ${x.store}` : x.customer, type: x.type, q: {}, total: 0, value: 0 }; stores.push(byKey[key]) }
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
