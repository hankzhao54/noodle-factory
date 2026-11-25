import { useState } from 'react'
import { Link } from 'react-router-dom'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead } from '../components/ui'
import LabelPrint, { shelfDays } from '../components/LabelPrint'

// Packing labels (Nov 2026): every label for packs made out of a production box is printed here, from the batch
// it came out of, so it keeps that batch's lot number, production time and use-by date (traceable).
// A batch that was packed before carries a warning, both in this list and in the print window.
const DAY = 864e5

export default function PackLabels() {
  const t = useT()
  const [productId, setProductId] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [printFor, setPrintFor] = useState(null)
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
      <PageHead title={t('packLabels')} />
      <p className="muted">{t('packLabelsIntro')}</p>
      <div className="date-chips">
        <button type="button" className={!productId ? 'chip on' : 'chip'} onClick={() => setProductId('')}>{t('all')}</button>
        {data.products.map(p => <button key={p.id} type="button" className={productId === p.id ? 'chip on' : 'chip'} onClick={() => setProductId(p.id)}>{t.pick(p)}</button>)}
        <label className="check-inline"><input type="checkbox" checked={showOld} onChange={e => setShowOld(e.target.checked)} />{t('showExpired')}</label>
      </div>
      {loading && <Loading />}
      {rows.length === 0 ? <p className="empty">{t('noBatchesToPack')}</p> : (
        <div className="table-wrap"><table className="table">
          <thead><tr>
            <th>{t('lot')}</th><th>{t('product')}</th><th>{t('producedAt')}</th><th>{t('expiry')}</th>
            <th className="num">{t('actualQty')}</th><th>{t('packedSoFar')}</th><th></th>
          </tr></thead>
          <tbody>{rows.map(b => {
            const p = prod(b.product_id), ub = useBy(b), pk = packsOf(b.id)
            const expired = ub && ub.getTime() < now
            const last = pk.reduce((a, x) => (!a || x.printed_at > a.printed_at ? x : a), null)
            return (
              <tr key={b.id} className={expired ? 'row-muted' : ''}>
                <td><Link to={`/trace/${encodeURIComponent(b.lot_no)}`}><b>{b.lot_no}</b></Link></td>
                <td>{p ? t.pick(p) : '–'}</td>
                <td>{fmtDT(b.done_at)}</td>
                <td>{ub ? fmtDate(ub.toISOString().slice(0, 10), t.lang) : '–'}{expired && <span className="tag tag-low">{t('expired')}</span>}</td>
                <td className="num">{fmtNum(b.actual_qty, t.lang)} {p?.unit || 'kg'}</td>
                <td>{pk.length
                  ? <span className="tag tag-low">⚠ {t('packedTimes', { n: pk.length, l: pk.reduce((a, x) => a + x.labels, 0), kg: fmtNum(Math.round(pk.reduce((a, x) => a + kgOf(x), 0) * 10) / 10, t.lang) })}</span>
                  : <span className="muted">–</span>}
                  {last && <div className="muted small">{fmtDT(last.printed_at)}{last.printed_by_name ? ` · ${last.printed_by_name}` : ''}</div>}</td>
                <td className="num"><button className="btn btn-sm btn-primary" disabled={expired} onClick={() => setPrintFor(b.id)}>{t('printPackLabels')}</button></td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}
      {printFor && <LabelPrint pack batchId={printFor} onPrinted={reload} onClose={() => { setPrintFor(null); reload() }} />}
    </div>
  )
}
