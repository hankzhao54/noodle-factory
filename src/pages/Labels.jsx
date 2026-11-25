import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import QrScanner, { lotFromScan } from '../components/QrScanner'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Modal, Field, NumInput, useToast, errText } from '../components/ui'
import LabelPrint, { shelfDays } from '../components/LabelPrint'
import { Finish } from './Production'
import { expYield } from '../lib/plan'

// Labels (Nov 2026): one place, made for the phone, to print both kinds of label from a finished batch:
//  - production label (the box, ~10 kg = one batch): lot number as is (261123-30, -01/-02 for several);
//  - packing label (packs made out of a box): the batch's lot with a pack number (261123-30/P01 …), the batch's
//    production time and use-by date, plus a packed date; every print run is recorded and a batch that was
//    packed before carries a warning, here and in the print window.
const DAY = 864e5

export default function Labels() {
  const t = useT()
  const [productId, setProductId] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [printFor, setPrintFor] = useState(null) // { id, pack }
  const [finishing, setFinishing] = useState(null)
  const [quick, setQuick] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [lotOnly, setLotOnly] = useState(() => new URLSearchParams(window.location.search).get('lot') || '')
  const [scanMsg, setScanMsg] = useState('')
  const navigate = useNavigate()
  const { data, error, loading, reload } = useData(async () => {
    const since = new Date(Date.now() - 45 * DAY).toISOString()
    const [products, batches, packs, cfg, planned] = await Promise.all([
      q(db.from('products').select('id,name_hu,name_en,name_zh,unit,sort,shelf_life_days,active,batch_yield,loss_pct').eq('active', true).order('sort')),
      q(db.from('production_batches').select('id,no,product_id,lot_no,done_at,actual_qty,batches').eq('status', 'done').not('lot_no', 'is', null)
        .gte('done_at', since).order('done_at', { ascending: false })),
      q(db.from('pack_labels').select('batch_id,labels,qty_per_label,unit,printed_at,printed_by_name').gte('printed_at', since)),
      q(db.from('settings').select('key,value')),
      q(db.from('production_batches').select('id,no,product_id,planned_date,batches,status').eq('status', 'planned').lte('planned_date', todayISO(1)).order('planned_date')),
    ])
    return { products, batches, packs, planned, cfg: Object.fromEntries(cfg.map(r => [r.key, r.value || ''])) }
  }, [])

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data) return <div className="page"><Loading /></div>
  const prod = id => data.products.find(p => p.id === id)
  const useBy = b => {
    const d = shelfDays(prod(b.product_id), data.cfg)
    return d == null ? null : new Date(new Date(b.done_at).getTime() + d * DAY)
  }
  const now = Date.now()
  const packsOf = id => data.packs.filter(x => x.batch_id === id)
  const kgOf = x => x.unit === 'kg' ? x.labels * Number(x.qty_per_label || 0) : x.unit === 'g' ? x.labels * Number(x.qty_per_label || 0) / 1000 : 0
  const rows = data.batches
    .filter(b => !lotOnly || b.lot_no === lotOnly)
    .filter(b => lotOnly || !productId || b.product_id === productId)
    .filter(b => lotOnly || showOld || !useBy(b) || useBy(b).getTime() >= now)
  const fmtDT = d => new Date(d).toLocaleString(t.lang === 'zh' ? 'zh-CN' : t.lang === 'en' ? 'en-GB' : 'hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="page">
      <PageHead title={`🏷 ${t('nav_labels')}`}>
        <button className="btn" onClick={() => setScanning(true)}>📷 {t('scan')}</button>
        <button className="btn btn-primary" onClick={() => setQuick(true)}>＋ {t('quickBatch')}</button>
      </PageHead>
      {scanMsg && <p className="note-box short-box">{scanMsg}</p>}
      {lotOnly && <p className="note-box">📷 {t('scanShowing', { lot: lotOnly })} <button className="btn-link" onClick={() => setLotOnly('')}>{t('showAll')}</button></p>}
      {!lotOnly && data.planned.length > 0 && <>
        <h2 className="label-sub">{t('toFinish')}</h2>
        <div className="label-cards">{data.planned.map(b => {
          const p = prod(b.product_id)
          return (
            <div key={b.id} className="label-card">
              <div className="label-card-head">
                <span className="label-card-lot">B{b.no}</span><b>{p ? t.pick(p) : '–'}</b>
                <span className="muted">{fmtNum(b.batches, t.lang)} × · ≈ {fmtNum(Math.round(b.batches * expYield(p) * 10) / 10, t.lang)} {p?.unit || 'kg'}</span>
              </div>
              <div className="muted small">{fmtDate(b.planned_date, t.lang)}</div>
              <button className="btn btn-primary btn-big" onClick={() => setFinishing(b)}>✓ {t('finishAndLabel')}</button>
            </div>
          )
        })}</div>
        <h2 className="label-sub">{t('finishedBatches')}</h2>
      </>}
      <p className="muted small">{t('labelsIntro')}</p>
      <div className="date-chips">
        <button type="button" className={!productId ? 'chip on' : 'chip'} onClick={() => setProductId('')}>{t('all')}</button>
        {data.products.map(p => <button key={p.id} type="button" className={productId === p.id ? 'chip on' : 'chip'} onClick={() => setProductId(p.id)}>{t.pick(p)}</button>)}
        <label className="check-inline"><input type="checkbox" checked={showOld} onChange={e => setShowOld(e.target.checked)} />{t('showExpired')}</label>
      </div>
      {loading && <Loading />}
      {rows.length === 0 ? <p className="empty">{t('noBatchesToPack')}</p> : (
        <div className="label-cards">{rows.map(b => {
          const p = prod(b.product_id), ub = useBy(b), pk = packsOf(b.id)
          const expired = ub && ub.getTime() < now
          const last = pk.reduce((a, x) => (!a || x.printed_at > a.printed_at ? x : a), null)
          return (
            <div key={b.id} className={`label-card${expired ? ' row-muted' : ''}`}>
              <div className="label-card-head">
                <Link to={`/trace/${encodeURIComponent(b.lot_no)}`} className="label-card-lot">{b.lot_no}</Link>
                <b>{p ? t.pick(p) : '–'}</b>
                <span className="muted">{fmtNum(b.actual_qty, t.lang)} {p?.unit || 'kg'}</span>
              </div>
              <div className="muted small">
                {t('producedAt')}: {fmtDT(b.done_at)} · {t('expiry')}: {ub ? fmtDate(ub.toISOString().slice(0, 10), t.lang) : '–'}
                {expired && <span className="tag tag-low">{t('expired')}</span>}
              </div>
              {pk.length > 0 && <div className="label-card-packed">
                <span className="tag tag-low">⚠ {t('packedTimes', { n: pk.length, l: pk.reduce((a, x) => a + x.labels, 0), kg: fmtNum(Math.round(pk.reduce((a, x) => a + kgOf(x), 0) * 10) / 10, t.lang) })}</span>
                {last && <span className="muted small"> {fmtDT(last.printed_at)}{last.printed_by_name ? ` · ${last.printed_by_name}` : ''}</span>}
              </div>}
              <div className="label-card-actions">
                <button className="btn" disabled={expired} onClick={() => setPrintFor({ id: b.id, pack: false })}>🏷 {t('boxLabel')}</button>
                <button className="btn btn-primary" disabled={expired} onClick={() => setPrintFor({ id: b.id, pack: true })}>📦 {t('packLabel')}</button>
              </div>
            </div>
          )
        })}</div>
      )}
      {finishing && <Finish batch={finishing} product={prod(finishing.product_id)} onClose={() => setFinishing(null)}
        onDone={print => { const id = finishing.id; setFinishing(null); reload(); if (print) setPrintFor({ id, pack: false }) }} />}
      {scanning && <QrScanner onClose={() => setScanning(false)} onResult={text => {
        setScanning(false)
        const lot = lotFromScan(text)
        if (!lot) { setScanMsg(t('scanNotLabel')); return }
        setScanMsg('')
        if (data.batches.some(b => b.lot_no === lot)) { setLotOnly(lot); window.scrollTo(0, 0) }
        else navigate(`/trace/${encodeURIComponent(lot)}`)   // older than 45 days: show its trace page
      }} />}
      {quick && <QuickBatch products={data.products} onClose={() => setQuick(false)}
        onDone={(id, print) => { setQuick(false); reload(); if (print) setPrintFor({ id, pack: false }) }} />}
      {printFor && <LabelPrint pack={printFor.pack} batchId={printFor.id} onPrinted={reload} onClose={() => { setPrintFor(null); reload() }} />}
    </div>
  )
}

// a batch made without planning it first: record it and finish it in one go, then print its label
function QuickBatch({ products, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [pid, setPid] = useState(products[0]?.id || '')
  const p = products.find(x => x.id === pid)
  const [batches, setBatches] = useState(1)
  const [qty, setQty] = useState(null)
  const [printAfter, setPrintAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const shownQty = qty ?? Math.round(batches * expYield(p) * 10) / 10
  async function save(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const [b] = await q(db.from('production_batches').insert({ product_id: pid, planned_date: todayISO(), batches, status: 'planned' }).select('id'))
      await q(db.rpc('complete_production', { p_batch_id: b.id, p_actual_qty: shownQty, p_lot_no: null }))
      toast(t('b_done')); onDone(b.id, printAfter)
    } catch (err) { toast(errText(err), 'error') }
    setBusy(false)
  }
  return (
    <Modal title={t('quickBatch')} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <p className="muted small">{t('quickBatchHint')}</p>
        <div className="date-chips">{products.map(x => (
          <button key={x.id} type="button" className={pid === x.id ? 'chip on' : 'chip'} onClick={() => { setPid(x.id); setQty(null) }}>{t.pick(x)}</button>
        ))}</div>
        <div className="row-gap">
          <Field label={t('batches')}><NumInput value={batches} min={0.1} onChange={v => { setBatches(v); setQty(null) }} required /></Field>
          <Field label={`${t('actualQty')} (${p?.unit || 'kg'})`}><NumInput value={shownQty} min={0} onChange={setQty} required /></Field>
        </div>
        <label className="check-inline"><input type="checkbox" checked={printAfter} onChange={e => setPrintAfter(e.target.checked)} />{t('printAfterFinish')}</label>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !pid}>{t('finish')}</button></div>
      </form>
    </Modal>
  )
}
