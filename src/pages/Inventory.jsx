import { useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtFt } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Tabs, Strand, NumInput, useToast, errText } from '../components/ui'

export default function Inventory() {
  const t = useT()
  const [tab, setTab] = useState('materials')
  const [adjusting, setAdjusting] = useState(null)
  const [term, setTerm] = useState('')
  const { data, loading, error, reload } = useData(async () => {
    const [materials, products] = await Promise.all([
      q(db.from('material_stock').select('*').order('name_zh')),
      q(db.from('product_stock').select('*').order('name_zh')),
    ])
    return { materials, products }
  })
  const match = r => !term || [r.name_zh, r.name_en, r.name_hu, r.code, r.category].some(x => x?.toLowerCase().includes(term.toLowerCase()))

  return (
    <div className="page">
      <PageHead title={t('nav_inventory')}>
        <input className="search" type="search" placeholder={t('search')} value={term} onChange={e => setTerm(e.target.value)} aria-label={t('search')} />
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[['materials', t('materialsTab')], ['products', t('productsTab')], ['moves', t('movementsTab')]]} />
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : tab === 'moves' ? <Movements data={data} /> : !data ? null : tab === 'materials' ? (
        data.materials.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('name')}</th><th className="hide-sm">{t('category')}</th><th className="strand-col" /><th className="num">{t('onHand')}</th>
              <th className="num">{t('minStock')}</th><th className="num">{t('total')}</th><th /></tr></thead>
            <tbody>{data.materials.filter(match).map(m => (
              <tr key={m.id} className={m.below_min ? 'row-low' : ''}>
                <td><b>{t.pick(m)}</b>{m.below_min && <span className="tag tag-low">{t('belowMin')}</span>}</td>
                <td className="muted hide-sm">{t.cat(m.category) || '–'}</td>
                <td className="strand-col"><Strand value={m.on_hand} min={m.min_stock} unit={m.unit} /></td>
                <td className="num"><b>{fmtNum(m.on_hand, t.lang)}</b> <span className="unit">{m.unit}</span></td>
                <td className="num muted">{fmtNum(m.min_stock, t.lang)}</td>
                <td className="num muted">{fmtFt(m.on_hand * m.cost_per_unit, t.lang)}</td>
                <td className="act"><button className="btn btn-quiet" onClick={() => setAdjusting({ kind: 'material', row: m })}>{t('adjust')}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )
      ) : (
        data.products.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('name')}</th><th className="num">{t('onHand')}</th><th className="num">{t('reserved')}</th><th className="num">{t('available')}</th><th /></tr></thead>
            <tbody>{data.products.filter(match).map(p => {
              const avail = p.on_hand - p.reserved
              return (
                <tr key={p.id} className={avail < 0 ? 'row-low' : ''}>
                  <td><b>{t.pick(p)}</b></td>
                  <td className="num">{fmtNum(p.on_hand, t.lang)} <span className="unit">{p.unit}</span></td>
                  <td className="num muted">{fmtNum(p.reserved, t.lang)}</td>
                  <td className={`num ${avail < 0 ? 'neg' : ''}`}><b>{fmtNum(avail, t.lang)}</b></td>
                  <td className="act"><button className="btn btn-quiet" onClick={() => setAdjusting({ kind: 'product', row: p })}>{t('adjust')}</button></td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )
      )}
      {adjusting && <Adjust {...adjusting} onClose={() => setAdjusting(null)} onDone={async () => { setAdjusting(null); await reload() }} />}
    </div>
  )
}

function Adjust({ kind, row, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [mode, setMode] = useState('count')
  const [qty, setQty] = useState(null)
  const [note, setNote] = useState('')
  const delta = mode === 'count' ? (qty ?? row.on_hand) - row.on_hand : -(qty || 0)

  async function save(e) {
    e.preventDefault()
    if (!delta) return onClose()
    try {
      await q(db.from('stock_movements').insert({
        [kind === 'material' ? 'material_id' : 'product_id']: row.id,
        qty: delta, reason: mode === 'count' ? 'count' : 'waste', note: note || null,
      }))
      toast(t('saved')); onDone()
    } catch (err) { toast(errText(err), 'error') }
  }

  return (
    <Modal title={`${t('adjust')} · ${t.pick(row)}`} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <Tabs value={mode} onChange={m => { setMode(m); setQty(null) }} tabs={[['count', t('r_count')], ['waste', t('waste')]]} />
        <p className="muted">{t('onHand')}: <b>{fmtNum(row.on_hand, t.lang)} {row.unit}</b></p>
        <Field label={mode === 'count' ? t('newCount') : t('qty')}>
          <NumInput value={qty} onChange={setQty} required min={0} />
        </Field>
        <Field label={t('notes')}><input value={note} onChange={e => setNote(e.target.value)} /></Field>
        <p className={delta < 0 ? 'neg' : 'pos'}>{delta > 0 ? '+' : ''}{fmtNum(delta, t.lang)} {row.unit}</p>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('save')}</button>
        </div>
      </form>
    </Modal>
  )
}

function Movements({ data }) {
  const t = useT()
  const { data: moves, loading } = useData(() => q(db.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(300)))
  if (loading || !data) return <Loading />
  if (!moves?.length) return <Empty />
  const item = m => m.material_id ? data.materials.find(x => x.id === m.material_id) : data.products.find(x => x.id === m.product_id)
  return (
    <div className="table-wrap"><table className="table compact">
      <thead><tr><th>{t('date')}</th><th>{t('item')}</th><th>{t('reason')}</th><th className="num">{t('qty')}</th><th>{t('lot')}</th><th>{t('notes')}</th></tr></thead>
      <tbody>{moves.map(m => {
        const it = item(m)
        return (
          <tr key={m.id}>
            <td className="muted nowrap">{new Date(m.created_at).toLocaleString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'en' ? 'en-GB' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
            <td>{it ? t.pick(it) : '–'}</td>
            <td>{t('r_' + m.reason)}</td>
            <td className={`num ${m.qty < 0 ? 'neg' : 'pos'}`}>{m.qty > 0 ? '+' : ''}{fmtNum(m.qty, t.lang)} <span className="unit">{it?.unit}</span></td>
            <td className="muted">{m.lot_no || ''}</td>
            <td className="muted">{m.note || ''}</td>
          </tr>
        )
      })}</tbody>
    </table></div>
  )
}
