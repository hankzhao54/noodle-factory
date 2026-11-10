import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Status, Tabs, NumInput, useToast, errText } from '../components/ui'
import { Link } from 'react-router-dom'
import LabelPrint from '../components/LabelPrint'
import { buildPlan, materialNeeds, expYield, theoYield, lossPct } from '../lib/plan'

export default function Production() {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(todayISO(1))
  const [tab, setTab] = useState('planned')
  const [finishing, setFinishing] = useState(null)
  const [adding, setAdding] = useState(null)
  const [labelFor, setLabelFor] = useState(null)
  const [undoAsk, setUndoAsk] = useState(null)       // batch id waiting for "yes, undo"
  const { isAdmin } = useAuth()
  const { data, loading, error, reload } = useData(async () => {
    const [products, recipe, mstock, pstock, demand, batches] = await Promise.all([
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,batch_yield,loss_pct,sort').eq('active', true).order('sort')),
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
  const open = data.batches.filter(b => b.status === 'planned')

  // plan rows: open orders due on/before the date, minus stock, minus batches already planned
  const plan = buildPlan(data)

  // materials needed for all open batches vs stock
  const byProduct = {}
  open.forEach(b => { byProduct[b.product_id] = (byProduct[b.product_id] || 0) + Number(b.batches) })
  const needRows = materialNeeds(byProduct, data.recipe, data.mstock)

  const shown = data.batches.filter(b => tab === 'all' || b.status === tab)

  // admin: put a batch finished by mistake back to planned (stock and lot are reversed)
  async function undoFinish(b) {
    try { await q(db.rpc('undo_production', { p_batch_id: b.id })); setUndoAsk(null); toast(t('undoFinishDone')); reload() }
    catch (e) { setUndoAsk(null); toast(/lot already used/.test(e.message || '') ? t('undoFinishUsed') : errText(e), 'error') }
  }

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
            <th className="num">{t('expectedQty')}</th><th className="num">{t('actualQty')}</th><th className="num">{t('lossCol')}</th><th>{t('lot')}</th><th>{t('status')}</th><th /></tr></thead>
          <tbody>{shown.map(b => {
            const p = prod(b.product_id)
            return (
              <tr key={b.id}>
                <td className="mono-num">B{b.no}</td>
                <td>{fmtDate(b.planned_date, t.lang)}</td>
                <td><b>{t.pick(p)}</b></td>
                <td className="num">{fmtNum(b.batches, t.lang)}</td>
                <td className="num muted">{fmtNum(b.batches * expYield(p), t.lang)} {p.unit}</td>
                <td className="num">{b.actual_qty != null ? fmtNum(b.actual_qty, t.lang) : '–'}</td>
                <td className="num"><LossTag batch={b} product={p} /></td>
                <td className="muted">{b.lot_no ? <Link to={`/trace/${encodeURIComponent(b.lot_no)}`}>{b.lot_no}</Link> : '–'}</td>
                <td><Status value={b.status} prefix="b" /></td>
                <td className="act">{b.status === 'done' && <>
                  {isAdmin && (undoAsk === b.id
                    ? <button className="btn btn-sm btn-danger" onClick={() => undoFinish(b)}>{t('undoFinishConfirm')}</button>
                    : <button className="btn btn-quiet btn-sm" title={t('undoFinishHint')} onClick={() => setUndoAsk(b.id)}>{t('undoFinish')}</button>)}
                  <button className="btn btn-sm" onClick={() => setLabelFor(b.id)}>{t('printLabels')}</button></>}{b.status === 'planned' && <>
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
        <Field label={t('batches')} hint={`${t('expectedQty')}: ${fmtNum((v.batches || 0) * expYield(p), t.lang)} ${p.unit || ''}${Number(p.loss_pct) ? ` (−${fmtNum(p.loss_pct, t.lang)}%)` : ''}`}>
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
  const theo = batch.batches * theoYield(product)
  const [qty, setQty] = useState(Math.round(batch.batches * expYield(product) * 1000) / 1000)
  const loss = theo ? (1 - (Number(qty) || 0) / theo) * 100 : null
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
          hint={`${t('theoQty')}: ${fmtNum(theo, t.lang)} · ${t('expectedQty')}: ${fmtNum(batch.batches * expYield(product), t.lang)}`}>
          <NumInput value={qty} onChange={setQty} required min={0} />
        </Field>
        {loss != null && <p className={`small ${loss > Number(product.loss_pct || 0) + 2 ? 'error-box' : 'muted'}`}>
          {t('lossNow', { a: fmtNum(theo - (Number(qty) || 0), t.lang), u: product.unit, p: fmtNum(loss, t.lang, 1), e: fmtNum(product.loss_pct || 0, t.lang, 1) })}</p>}
        <Field label={t('lot')} hint="YYMMDD-#"><input value={lot} onChange={e => setLot(e.target.value)} /></Field>
        <label className="check-inline"><input type="checkbox" checked={printAfter} onChange={e => setPrintAfter(e.target.checked)} />{t('printAfterFinish')}</label>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('finish')}</button></div>
      </form>
    </Modal>
  )
}

// loss of a finished batch vs the theoretical output; red when clearly above the usual loss
function LossTag({ batch, product }) {
  const t = useT()
  const l = lossPct(batch, product)
  if (l == null) return '–'
  const high = l > Number(product.loss_pct || 0) + 2
  return <span className={high ? 'tag tag-low' : 'muted'} title={t('lossVsTheo')}>{fmtNum(l, t.lang, 1)}%</span>
}
