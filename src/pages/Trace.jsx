import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, Status } from '../components/ui'
import LabelPrint from '../components/LabelPrint'

const KG = { kg: 1, g: 0.001, l: 1, ml: 0.001 }
const kg = l => Number(l.qty_per_batch) * (KG[l.materials?.unit] ?? 0)

// opened by scanning the QR code on a label: /trace/<lot>
export default function Trace() {
  const t = useT()
  const { lot } = useParams()
  const [printing, setPrinting] = useState(false)
  const { data, loading, error } = useData(async () => {
    const batches = await q(db.from('production_batches').select('*').eq('lot_no', lot).limit(1))
    const b = batches[0]
    if (!b) return { batch: null }
    const [product, lines, moves] = await Promise.all([
      q(db.from('products').select('*').eq('id', b.product_id).single()),
      q(db.from('recipe_lines').select('qty_per_batch, materials(id,name_zh,name_en,name_hu,unit,allergens)').eq('product_id', b.product_id)),
      q(db.from('stock_movements').select('*').eq('ref_id', b.id)),
    ])
    // most recent received lots of each raw material before this batch was made
    const matIds = lines.map(l => l.materials?.id).filter(Boolean)
    const received = matIds.length ? await q(db.from('stock_movements').select('material_id,lot_no,expiry_date,created_at')
      .in('material_id', matIds).eq('reason', 'purchase').lte('created_at', b.done_at || new Date().toISOString())
      .order('created_at', { ascending: false }).limit(200)) : []
    return { batch: b, product, lines, moves, received }
  }, [lot])

  if (loading && !data) return <div className="page"><Loading /></div>
  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data.batch) return (
    <div className="page"><h1>{t('traceTitle')}</h1><p className="empty">{t('lotNotFound', { lot })}</p></div>
  )
  const { batch: b, product: p, lines, moves, received } = data
  const out = moves.find(m => m.reason === 'production_out')
  const lastLot = id => received.find(r => r.material_id === id)

  return (
    <div className="page trace">
      <p className="muted"><Link to="/production">{t('nav_production')}</Link> / {t('traceTitle')}</p>
      <div className="trace-head">
        <h1>{t.pick(p)}</h1>
        <span className="trace-lot">{b.lot_no}</span>
        <Status value={b.status} prefix="b" />
        <span className="grow" />
        {b.status === 'done' && <button className="btn btn-primary" onClick={() => setPrinting(true)}>{t('printLabels')}</button>}
      </div>
      <dl className="cust-info cust-panel">
        <div><dt>{t('producedAt')}</dt><dd>{b.done_at ? new Date(b.done_at).toLocaleString(t.lang === 'zh' ? 'zh-CN' : t.lang === 'en' ? 'en-GB' : 'hu-HU') : '–'}</dd></div>
        <div><dt>{t('expiry')}</dt><dd>{fmtDate(out?.expiry_date, t.lang)}</dd></div>
        <div><dt>{t('actualQty')}</dt><dd>{fmtNum(b.actual_qty, t.lang)} {p.unit} <span className="muted">({t('batches')}: {fmtNum(b.batches, t.lang)})</span></dd></div>
        {p.storage && <div><dt>{t('storage')}</dt><dd>{p.storage}</dd></div>}
        {b.notes && <div><dt>{t('notes')}</dt><dd>{b.notes}</dd></div>}
      </dl>
      <h2 className="trace-sub">{t('ingredientsUsed')}</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{t('nav_materials')}</th><th className="num">{t('qty')}</th><th>{t('allergens')}</th><th>{t('latestReceivedLot')}</th></tr></thead>
        <tbody>{[...lines].sort((a, z) => kg(z) - kg(a)).map((l, i) => {
          const m = l.materials || {}
          const r = lastLot(m.id)
          return (
            <tr key={i}>
              <td><b>{t.pick(m)}</b></td>
              <td className="num">{fmtNum(l.qty_per_batch * b.batches, t.lang)} <span className="unit">{m.unit}</span></td>
              <td>{(m.allergens || []).join(', ') || '–'}</td>
              <td className="muted">{r ? `${r.lot_no ? r.lot_no + ' · ' : ''}${fmtDate(r.created_at, t.lang)}${r.expiry_date ? ` → ${fmtDate(r.expiry_date, t.lang)}` : ''}` : '–'}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
      <p className="muted small" style={{ marginTop: 8 }}>{t('latestLotHint')}</p>
      {printing && <LabelPrint batchId={b.id} onClose={() => setPrinting(false)} />}
    </div>
  )
}
