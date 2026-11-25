import { useState } from 'react'
import { Link } from 'react-router-dom'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead } from '../components/ui'
import LabelPrint, { shelfDays } from '../components/LabelPrint'

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
  const { data, error, loading, reload } = useData(async () => {
    const since = new Date(Date.now() - 45 * DAY).toISOString()
    const [products, batches, packs, cfg] = await Promise.all([
      q(db.from('products').select('id,name_hu,name_en,name_zh,unit,sort,shelf_life_days,active').eq('active', true).order('sort')),
      q(db.from('production_batches').select('id,no,product_id,lot_no,done_at,actual_qty,batches').eq('status', 'done').not('lot_no', 'is', null)
        .gte('done_at', since).order('done_at', { ascending: false })),
      q(db.from('pack_labels').select('batch_id,labels,qty_per_label,unit,printed_at,printed_by_name').gte('printed_at', since)),
      q(db.from('settings').select('key,value')),
    ])
    return { products, batches, packs, cfg: Object.fromEntries(cfg.map(r => [r.key, r.value || ''])) }
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
    .filter(b => !productId || b.product_id === productId)
    .filter(b => showOld || !useBy(b) || useBy(b).getTime() >= now)
  const fmtDT = d => new Date(d).toLocaleString(t.lang === 'zh' ? 'zh-CN' : t.lang === 'en' ? 'en-GB' : 'hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="page">
      <PageHead title={`🏷 ${t('nav_labels')}`} />
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
      {printFor && <LabelPrint pack={printFor.pack} batchId={printFor.id} onPrinted={reload} onClose={() => { setPrintFor(null); reload() }} />}
    </div>
  )
}
