import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtFt } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty } from '../components/ui'

const monthStart = () => todayISO(0).slice(0, 8) + '01'
const endOfDay = iso => iso + 'T23:59:59.999'

// Simple management reports for a date range; every table can be downloaded as CSV.
export default function Reports() {
  const t = useT()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(todayISO())
  const { data, loading, error } = useData(async () => {
    const [products, materials, customers, suppliers, batches, orders, moves, pos] = await Promise.all([
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit')),
      q(db.from('materials').select('id,name_zh,name_en,name_hu,unit,cost_per_unit')),
      q(db.from('customers').select('id,name,type')),
      q(db.from('suppliers').select('id,name')),
      q(db.from('production_batches').select('product_id,batches,actual_qty,done_at').eq('status', 'done')
        .gte('done_at', from).lte('done_at', endOfDay(to))),
      q(db.from('orders').select('customer_id, delivery_date, order_lines(product_id, qty, delivered_qty, unit_price)')
        .eq('status', 'delivered').gte('delivery_date', from).lte('delivery_date', to)),
      q(db.from('stock_movements').select('material_id,product_id,qty,reason,created_at')
        .in('reason', ['production_use', 'waste']).gte('created_at', from).lte('created_at', endOfDay(to)).limit(10000)),
      q(db.from('purchase_orders').select('supplier_id, received_at, purchase_order_lines(received_qty, qty, unit_price)')
        .eq('status', 'received').gte('received_at', from).lte('received_at', endOfDay(to))),
    ])
    return { products, materials, customers, suppliers, batches, orders, moves, pos }
  }, [from, to])

  const presets = [
    [t('thisMonth'), monthStart(), todayISO()],
    [t('last30'), todayISO(-29), todayISO()],
    [t('thisYear'), todayISO().slice(0, 4) + '-01-01', todayISO()],
  ]

  return (
    <div className="page">
      <PageHead title={t('nav_reports')}>
        <label className="inline-field">{t('from')} <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label className="inline-field">{t('to')} <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
      </PageHead>
      <div className="date-chips">{presets.map(([label, f, tt]) => (
        <button key={label} type="button" className={from === f && to === tt ? 'chip on' : 'chip'} onClick={() => { setFrom(f); setTo(tt) }}>{label}</button>
      ))}</div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && <ReportBody data={data} range={`${from}_${to}`} />}
    </div>
  )
}

function ReportBody({ data, range }) {
  const t = useT()
  const byId = (list, id) => list.find(x => x.id === id) || {}
  const add = (map, key, patch) => {
    const cur = map.get(key) || {}
    const next = { ...cur }
    for (const [k, v] of Object.entries(patch)) next[k] = (cur[k] || 0) + v
    map.set(key, next)
  }

  // production
  const prod = new Map()
  data.batches.forEach(b => add(prod, b.product_id, { qty: Number(b.actual_qty || 0), n: 1, batches: Number(b.batches) }))
  // sales
  const byCust = new Map(), byProd = new Map()
  let revenue = 0, salesQty = 0
  data.orders.forEach(o => o.order_lines.forEach(l => {
    const qty = Number(l.delivered_qty ?? l.qty), val = qty * Number(l.unit_price || 0)
    revenue += val; salesQty += qty
    add(byCust, o.customer_id, { qty, val })
    add(byProd, l.product_id, { qty, val })
  }))
  // raw materials used / waste
  const used = new Map(), waste = new Map()
  let usedCost = 0, wasteCost = 0
  data.moves.forEach(m => {
    if (m.reason === 'production_use' && m.material_id) {
      const qty = -Number(m.qty), cost = qty * Number(byId(data.materials, m.material_id).cost_per_unit || 0)
      usedCost += cost; add(used, m.material_id, { qty, cost })
    } else if (m.reason === 'waste') {
      const key = m.material_id ? 'm:' + m.material_id : 'p:' + m.product_id
      const qty = -Number(m.qty)
      const cost = m.material_id ? qty * Number(byId(data.materials, m.material_id).cost_per_unit || 0) : 0
      wasteCost += cost; add(waste, key, { qty, cost })
    }
  })
  // purchasing
  const bySup = new Map()
  let spend = 0
  data.pos.forEach(p => p.purchase_order_lines.forEach(l => {
    const val = Number(l.received_qty ?? l.qty) * Number(l.unit_price || 0)
    spend += val; add(bySup, p.supplier_id, { val, n: 0 })
  }))
  data.pos.forEach(p => add(bySup, p.supplier_id, { n: 1 }))

  const totalProduced = [...prod.values()].reduce((s, x) => s + x.qty, 0)
  const sorted = (map, key) => [...map.entries()].sort((a, b) => (b[1][key] || 0) - (a[1][key] || 0))
  const itemName = key => key.startsWith('m:') ? byId(data.materials, key.slice(2)) : byId(data.products, key.slice(2))

  return (
    <>
      <div className="kpis">
        <Kpi label={t('kpiProduced')} value={`${fmtNum(totalProduced, t.lang)} kg`} />
        <Kpi label={t('kpiSold')} value={`${fmtNum(salesQty, t.lang)} kg`} />
        <Kpi label={t('kpiRevenue')} value={fmtFt(revenue, t.lang)} sub={t('net')} />
        <Kpi label={t('kpiMaterialCost')} value={fmtFt(usedCost, t.lang)} sub={revenue > 0 ? `${Math.round(usedCost / revenue * 100)}% ${t('ofRevenue')}` : ''} />
        <Kpi label={t('kpiPurchases')} value={fmtFt(spend, t.lang)} />
        <Kpi label={t('kpiWaste')} value={fmtFt(wasteCost, t.lang)} />
      </div>

      <Section title={t('repProduction')} file={`production_${range}`}
        head={[t('name'), t('batchesDone'), t('batches'), t('actualQty')]}
        rows={sorted(prod, 'qty').map(([id, x]) => { const p = byId(data.products, id); return [t.pick(p), x.n, fmtNum(x.batches, t.lang), `${fmtNum(x.qty, t.lang)} ${p.unit || ''}`] })}
        bars={sorted(prod, 'qty').map(([, x]) => x.qty)} barCol={3} />

      <Section title={t('repSalesCustomer')} file={`sales_by_customer_${range}`}
        head={[t('customer'), t('qty'), t('revenueNet'), t('share')]}
        rows={sorted(byCust, 'val').map(([id, x]) => {
          const c = byId(data.customers, id)
          return [c.name + (c.type === 'internal' ? ` (${t('internal')})` : ''), fmtNum(x.qty, t.lang), fmtFt(x.val, t.lang), revenue ? Math.round(x.val / revenue * 100) + '%' : '–']
        })}
        bars={sorted(byCust, 'val').map(([, x]) => x.val)} barCol={2} />

      <Section title={t('repSalesProduct')} file={`sales_by_product_${range}`}
        head={[t('name'), t('qty'), t('revenueNet'), t('avgPrice')]}
        rows={sorted(byProd, 'qty').map(([id, x]) => { const p = byId(data.products, id); return [t.pick(p), `${fmtNum(x.qty, t.lang)} ${p.unit || ''}`, fmtFt(x.val, t.lang), x.qty ? fmtFt(x.val / x.qty, t.lang) : '–'] })}
        bars={sorted(byProd, 'qty').map(([, x]) => x.qty)} barCol={1} />

      <Section title={t('repMaterials')} note={t('repMaterialsNote')} file={`materials_used_${range}`}
        head={[t('nav_materials'), t('qty'), t('cost')]}
        rows={sorted(used, 'cost').map(([id, x]) => { const m = byId(data.materials, id); return [t.pick(m), `${fmtNum(x.qty, t.lang)} ${m.unit || ''}`, fmtFt(x.cost, t.lang)] })}
        bars={sorted(used, 'cost').map(([, x]) => x.cost)} barCol={2} />

      <Section title={t('repPurchases')} file={`purchases_${range}`}
        head={[t('supplier'), t('poCount'), t('total')]}
        rows={sorted(bySup, 'val').map(([id, x]) => [byId(data.suppliers, id).name || '–', x.n, fmtFt(x.val, t.lang)])}
        bars={sorted(bySup, 'val').map(([, x]) => x.val)} barCol={2} />

      <Section title={t('repWaste')} file={`waste_${range}`}
        head={[t('item'), t('qty'), t('cost')]}
        rows={sorted(waste, 'qty').map(([key, x]) => { const it = itemName(key); return [t.pick(it), `${fmtNum(x.qty, t.lang)} ${it.unit || ''}`, key.startsWith('m:') ? fmtFt(x.cost, t.lang) : '–'] })} />
    </>
  )
}

function Kpi({ label, value, sub }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><b className="kpi-value">{value}</b>{sub && <span className="kpi-sub">{sub}</span>}</div>
}

function Section({ title, note, head, rows, bars, barCol, file }) {
  const t = useT()
  const max = bars?.length ? Math.max(...bars, 0) : 0
  function csv() {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const text = '﻿' + [head, ...rows].map(r => r.map(esc).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    a.download = `${file}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2>{rows.length > 0 && <button type="button" className="btn btn-sm btn-quiet" onClick={csv}>CSV ↓</button>}</div>
      {note && <p className="muted small pad-x">{note}</p>}
      {rows.length === 0 ? <Empty>{t('noDataRange')}</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr>{head.map((h, i) => <th key={i} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (
              <td key={j} className={j ? 'num' : ''}>
                {j === 0 ? <b>{c}</b> : c}
                {bars && j === barCol && max > 0 && <div className="bar"><span style={{ width: `${Math.max(2, bars[i] / max * 100)}%` }} /></div>}
              </td>))}</tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  )
}
