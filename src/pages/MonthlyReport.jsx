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

  function csv() {
    const rows = [[t('reportMonth'), r.month], []]
    rows.push([t('rpSalesByProduct')], [t('name'), t('qty'), t('rpInternal'), t('rpExternal'), t('rpNetValue')])
    r.sales_by_product.forEach(x => rows.push([x.name, num(x.qty), num(x.internal_qty), num(x.external_qty), num(x.value)]))
    rows.push([], [t('rpSalesByCustomer')], [t('customer'), t('rpOrders'), t('qty'), t('rpNetValue')])
    r.sales_by_customer.forEach(x => rows.push([x.name, x.orders, num(x.qty), num(x.value)]))
    const m = storeMatrix(r.sales_by_store_product)
    if (m.stores.length) {
      rows.push([], [t('rpByStoreProduct') + ' (kg)'], [t('customer'), ...m.prods.map(p => p.name), t('total'), t('rpNetValue')])
      m.stores.forEach(s => rows.push([s.name, ...m.prods.map(p => num(s.q[p.id] || 0)), num(s.total), Math.round(s.value)]))
      rows.push([t('total'), ...m.prods.map(p => num(m.totals[p.id])), num(m.stores.reduce((a, s) => a + s.total, 0)), Math.round(m.stores.reduce((a, s) => a + s.value, 0))])
    }
    rows.push([], [t('nav_production')], [t('name'), t('batches'), t('rpActual'), t('rpRecipe'), t('rpLoss')])
    r.production.forEach(x => rows.push([x.name, num(x.batches), num(x.actual), num(x.theoretical), x.loss_pct ?? '']))
    rows.push([], [t('rpMaterials')], [t('name'), t('rpUsed'), t('rpBought'), t('rpAdjusted'), t('rpEndStock'), t('unit'), t('rpEndValue')])
    r.materials.forEach(x => rows.push([x.name, num(x.used), num(x.bought), num(x.adjusted), num(x.end_stock), x.unit, Math.round(num(x.end_value))]))
    const text = rows.map(row => row.map(c => /[;"\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
    a.download = `teszta-havi-jelentes-${r.month}.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  return (
    <div className="page report-page">
      <PageHead title={t('nav_monthReport')}>
        <label className="inline-field">{t('reportMonth')}
          <input type="month" value={month} max={todayISO().slice(0, 7)} onChange={e => e.target.value && setMonth(e.target.value)} /></label>
        {r && <button className="btn" onClick={printReport}>{t('print')}</button>}
        {r && <button className="btn" onClick={csv}>CSV / Excel</button>}
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
