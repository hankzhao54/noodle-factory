import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Status, Tabs, NumInput, useToast, errText } from '../components/ui'
import { Link } from 'react-router-dom'
import LabelPrint from '../components/LabelPrint'

export default function Production() {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(todayISO(1))
  const [tab, setTab] = useState('planned')
  const [finishing, setFinishing] = useState(null)
  const [adding, setAdding] = useState(null)
  const [labelFor, setLabelFor] = useState(null)
  const { data, loading, error, reload } = useData(async () => {
    const [products, recipe, mstock, pstock, demand, batches] = await Promise.all([
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,batch_yield,sort').eq('active', true).order('sort')),
      q(db.from('recipe_lines').select('*')),
      q(db.from('material_stock').select('id,name_zh,name_en,name_hu,unit,on_hand')),
      q(db.from('product_stock').select('id,on_hand')),
      q(db.from('production_demand').select('*').lte('delivery_date', date)),
      q(db.from('production_batches').select('*').order('planned_date', { ascending: false }).order('created_at', { ascending: false }).limit(200)),
    ])
    return { products, recipe, mstock, pstock, demand, batches }
  }, [date])

  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>

  const prod = id => data.products.find(p => p.id === id) || {}
  const mat = id => data.mstock.find(m => m.id === id) || {}
  const open = data.batches.filter(b => b.status === 'planned')

  // plan rows: open orders due on/before the date, minus stock, minus batches already planned
  const plan = data.products.map(p => {
    const demand = data.demand.filter(d => d.product_id === p.id).reduce((s, d) => s + Number(d.qty), 0)
    const onHand = Number(data.pstock.find(s => s.id === p.id)?.on_hand || 0)
    const planned = open.filter(b => b.product_id === p.id).reduce((s, b) => s + b.batches * p.batch_yield, 0)
    const toMake = Math.max(0, demand - onHand - planned)
    return { p, demand, onHand, planned, toMake, suggest: toMake > 0 ? Math.ceil(toMake / (p.batch_yield || 1)) : 0 }
  }).filter(r => r.demand > 0 || r.planned > 0)

  // materials needed for all open batches vs stock
  const need = {}
  open.forEach(b => data.recipe.filter(r => r.product_id === b.product_id)
    .forEach(r => { need[r.material_id] = (need[r.material_id] || 0) + r.qty_per_batch * b.batches }))
  const needRows = Object.entries(need).map(([id, qty]) => ({ m: mat(id), qty, short: qty - Number(mat(id).on_hand || 0) }))
    .sort((a, b) => b.short - a.short)

  const shown = data.batches.filter(b => tab === 'all' || b.status === tab)

  async function cancelBatch(b) {
    try { await q(db.from('production_batches').update({ status: 'cancelled' }).eq('id', b.id)); reload() }
    catch (e) { toast(errText(e), 'error') }
  }

  return (
    <div className="page">
      <PageHead title={t('nav_production')}>
        <button className="btn btn-primary" onClick={() => setAdding({ product_id: data.products[0]?.id, batches: 1, planned_date: todayISO() })}>{t('planBatch')}</button>
      </PageHead>

      <section className="panel">
        <div className="panel-head">
          <h2>{t('plan')}</h2>
          <label className="inline-field">{t('forDate')}
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>
        </div>
        {plan.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('name')}</th><th className="num">{t('demand')}</th><th className="num">{t('onHand')}</th>
              <th className="num">{t('b_planned')}</th><th className="num">{t('toMake')}</th><th className="num">{t('batches')}</th><th /></tr></thead>
            <tbody>{plan.map(r => (
              <tr key={r.p.id} className={r.toMake > 0 ? 'row-todo' : ''}>
                <td><b>{t.pick(r.p)}</b></td>
                <td className="num">{fmtNum(r.demand, t.lang)} <span className="unit">{r.p.unit}</span></td>
                <td className="num muted">{fmtNum(r.onHand, t.lang)}</td>
                <td className="num muted">{fmtNum(r.planned, t.lang)}</td>
                <td className="num"><b>{fmtNum(r.toMake, t.lang)}</b></td>
                <td className="num">{r.suggest || '–'}</td>
                <td className="act">{r.suggest > 0 && <button className="btn btn-sm"
                  onClick={() => setAdding({ product_id: r.p.id, batches: r.suggest, planned_date: todayISO() })}>{t('planBatch')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {needRows.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>{t('materialsNeeded')}</h2></div>
          <ul className="need-list">
            {needRows.map(({ m, qty, short }) => (
              <li key={m.id} className={short > 0 ? 'is-short' : ''}>
                <span>{t.pick(m)}</span>
                <span className="num">{fmtNum(qty, t.lang)} / {fmtNum(m.on_hand, t.lang)} {m.unit}</span>
                {short > 0 && <span className="tag tag-low">{t('short')} {fmtNum(short, t.lang)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[['planned', t('b_planned')], ['done', t('b_done')], ['all', t('all')]]} />
      {shown.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>#</th><th>{t('date')}</th><th>{t('name')}</th><th className="num">{t('batches')}</th>
            <th className="num">{t('expectedQty')}</th><th className="num">{t('actualQty')}</th><th>{t('lot')}</th><th>{t('status')}</th><th /></tr></thead>
          <tbody>{shown.map(b => {
            const p = prod(b.product_id)
            return (
              <tr key={b.id}>
                <td className="mono-num">B{b.no}</td>
                <td>{fmtDate(b.planned_date, t.lang)}</td>
                <td><b>{t.pick(p)}</b></td>
                <td className="num">{fmtNum(b.batches, t.lang)}</td>
                <td className="num muted">{fmtNum(b.batches * (p.batch_yield || 0), t.lang)} {p.unit}</td>
                <td className="num">{b.actual_qty != null ? fmtNum(b.actual_qty, t.lang) : '–'}</td>
                <td className="muted">{b.lot_no ? <Link to={`/trace/${encodeURIComponent(b.lot_no)}`}>{b.lot_no}</Link> : '–'}</td>
                <td><Status value={b.status} prefix="b" /></td>
                <td className="act">{b.status === 'done' && <button className="btn btn-sm" onClick={() => setLabelFor(b.id)}>{t('printLabels')}</button>}{b.status === 'planned' && <>
                  <button className="btn btn-quiet" onClick={() => cancelBatch(b)}>{t('cancel')}</button>
                  <button className="btn btn-sm btn-primary" onClick={() => setFinishing(b)}>{t('finish')}</button>
                </>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}

      {adding && <AddBatch init={adding} products={data.products} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload() }} />}
      {finishing && <Finish batch={finishing} product={prod(finishing.product_id)} onClose={() => setFinishing(null)} onDone={print => { const id = finishing.id; setFinishing(null); reload(); if (print) setLabelFor(id) }} />}
      {labelFor && <LabelPrint batchId={labelFor} onClose={() => setLabelFor(null)} />}
    </div>
  )
}

function AddBatch({ init, products, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [v, setV] = useState({ ...init, notes: '' })
  const p = products.find(x => x.id === v.product_id) || {}
  async function save(e) {
    e.preventDefault()
    try { await q(db.from('production_batches').insert(v)); toast(t('saved')); onDone() }
    catch (err) { toast(errText(err), 'error') }
  }
  return (
    <Modal title={t('planBatch')} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <Field label={t('name')}>
          <select value={v.product_id} onChange={e => setV({ ...v, product_id: e.target.value })}>
            {products.map(x => <option key={x.id} value={x.id}>{t.pick(x)}</option>)}
          </select>
        </Field>
        <Field label={t('date')}><input type="date" value={v.planned_date} onChange={e => setV({ ...v, planned_date: e.target.value })} /></Field>
        <Field label={t('batches')} hint={`${t('expectedQty')}: ${fmtNum((v.batches || 0) * (p.batch_yield || 0), t.lang)} ${p.unit || ''}`}>
          <NumInput value={v.batches} onChange={x => setV({ ...v, batches: x })} required min={0.1} />
        </Field>
        <Field label={t('notes')}><input value={v.notes} onChange={e => setV({ ...v, notes: e.target.value })} /></Field>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('save')}</button></div>
      </form>
    </Modal>
  )
}

function Finish({ batch, product, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [qty, setQty] = useState(batch.batches * (product.batch_yield || 0))
  const [lot, setLot] = useState('')
  const [printAfter, setPrintAfter] = useState(true)
  async function save(e) {
    e.preventDefault()
    try {
      await q(db.rpc('complete_production', { p_batch_id: batch.id, p_actual_qty: qty, p_lot_no: lot || null }))
      toast(t('b_done')); onDone(printAfter)
    } catch (err) { toast(errText(err), 'error') }
  }
  return (
    <Modal title={`${t('finish')} · B${batch.no} ${t.pick(product)}`} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <Field label={`${t('actualQty')} (${product.unit})`}
          hint={`${t('expectedQty')}: ${fmtNum(batch.batches * (product.batch_yield || 0), t.lang)}`}>
          <NumInput value={qty} onChange={setQty} required min={0} />
        </Field>
        <Field label={t('lot')} hint="YYMMDD-#"><input value={lot} onChange={e => setLot(e.target.value)} /></Field>
        <label className="check-inline"><input type="checkbox" checked={printAfter} onChange={e => setPrintAfter(e.target.checked)} />{t('printAfterFinish')}</label>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('finish')}</button></div>
      </form>
    </Modal>
  )
}
