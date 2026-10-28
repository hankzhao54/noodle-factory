import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Status, Tabs, NumInput, useToast, errText } from '../components/ui'

export default function Purchasing() {
  const t = useT()
  const toast = useToast()
  const [filter, setFilter] = useState('open')
  const [open, setOpen] = useState(null)        // PO being edited / received
  const { data, loading, error, reload } = useData(async () => {
    const [pos, suppliers, materials, low] = await Promise.all([
      q(db.from('purchase_orders').select('*, purchase_order_lines(qty, unit_price)').order('created_at', { ascending: false }).limit(200)),
      q(db.from('suppliers').select('id,name').eq('active', true).order('name')),
      q(db.from('materials').select('id,name_zh,name_en,name_hu,unit,cost_per_unit,default_supplier_id').eq('active', true).order('name_zh')),
      q(db.from('material_stock').select('*').eq('below_min', true)),
    ])
    return { pos, suppliers, materials, low }
  })

  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>
  const supName = id => data.suppliers.find(s => s.id === id)?.name || '–'
  const pos = data.pos.filter(p => filter === 'all' || (filter === 'open' ? ['draft', 'ordered'].includes(p.status) : p.status === filter))

  // create a draft PO for one supplier, pre-filled with every low item from that supplier
  async function draftFromLow(supplierId) {
    try {
      const po = await q(db.from('purchase_orders').insert({ supplier_id: supplierId }).select().single())
      const lines = data.low.filter(m => m.default_supplier_id === supplierId).map(m => ({
        po_id: po.id, material_id: m.id, unit_price: m.cost_per_unit,
        qty: Math.max(Number(m.min_stock) * 2 - Number(m.on_hand), 1),
      }))
      if (lines.length) await q(db.from('purchase_order_lines').insert(lines))
      await reload(); setOpen(po)
    } catch (e) { toast(errText(e), 'error') }
  }

  const lowBySupplier = {}
  data.low.forEach(m => { const k = m.default_supplier_id || ''; (lowBySupplier[k] ||= []).push(m) })

  return (
    <div className="page">
      <PageHead title={t('nav_purchasing')}>
        <button className="btn btn-primary" onClick={() => setOpen({ supplier_id: data.suppliers[0]?.id, order_date: todayISO() })}>{t('newPO')}</button>
      </PageHead>

      {data.low.length > 0 && (
        <section className="notice">
          <h2>{t('suggestReorder')}</h2>
          <ul className="low-list">
            {Object.entries(lowBySupplier).map(([sid, items]) => (
              <li key={sid}>
                <span className="low-sup">{sid ? supName(sid) : '–'}</span>
                <span className="low-items">{items.map(m => `${t.pick(m)} ${fmtNum(m.on_hand, t.lang)}/${fmtNum(m.min_stock, t.lang)} ${m.unit}`).join(' · ')}</span>
                {sid && <button className="btn btn-sm" onClick={() => draftFromLow(sid)}>{t('addToPO')}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Tabs value={filter} onChange={setFilter} tabs={[
        ['open', `${t('po_draft')} / ${t('po_ordered')}`], ['received', t('po_received')], ['all', t('all')],
      ]} />
      {pos.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr>
            <th>#</th><th>{t('supplier')}</th><th>{t('date')}</th><th>{t('expected')}</th>
            <th>{t('status')}</th><th className="num">{t('total')}</th><th />
          </tr></thead>
          <tbody>{pos.map(p => (
            <tr key={p.id} className="clickable" onClick={() => setOpen(p)}>
              <td className="mono-num">P{p.no}</td>
              <td><b>{supName(p.supplier_id)}</b></td>
              <td>{fmtDate(p.order_date, t.lang)}</td>
              <td>{fmtDate(p.expected_date, t.lang)}</td>
              <td><Status value={p.status} prefix="po" /></td>
              <td className="num">{fmtFt(p.purchase_order_lines.reduce((s, l) => s + l.qty * l.unit_price, 0), t.lang)}</td>
              <td className="act"><button className="btn btn-quiet">{p.status === 'ordered' ? t('receive') : t('edit')}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      {open && <POEditor po={open} data={data} supName={supName}
        onClose={() => setOpen(null)} onDone={async () => { setOpen(null); await reload() }} />}
    </div>
  )
}

function POEditor({ po, data, supName, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [head, setHead] = useState({ supplier_id: po.supplier_id, order_date: po.order_date, expected_date: po.expected_date || '', notes: po.notes || '' })
  const { data: loaded } = useData(() => po.id
    ? q(db.from('purchase_order_lines').select('*').eq('po_id', po.id))
    : Promise.resolve([]), [po.id])
  const [lines, setLines] = useState(null)
  const L = lines ?? loaded?.map(l => ({ ...l, received_qty: l.received_qty ?? l.qty, expiry_date: l.expiry_date || '', lot_no: l.lot_no || '' }))
  const editable = !po.id || po.status === 'draft' || po.status === 'ordered'
  const receiving = po.status === 'ordered'
  const mat = id => data.materials.find(m => m.id === id) || {}
  const setLine = (i, patch) => setLines(L.map((l, j) => j === i ? { ...l, ...patch } : l))
  const [busy, setBusy] = useState(false)

  async function persist(status) {
    const payload = { ...head, expected_date: head.expected_date || null, ...(status ? { status } : {}) }
    const saved = po.id
      ? await q(db.from('purchase_orders').update(payload).eq('id', po.id).select().single())
      : await q(db.from('purchase_orders').insert(payload).select().single())
    if (status === 'cancelled' || po.status === 'received') return saved
    const keep = L.filter(l => l.material_id && l.qty > 0)
    // replace lines (simple + safe while the PO is not received yet)
    await q(db.from('purchase_order_lines').delete().eq('po_id', saved.id))
    if (keep.length) await q(db.from('purchase_order_lines').insert(keep.map(l => ({
      po_id: saved.id, material_id: l.material_id, qty: l.qty, unit_price: l.unit_price || 0,
    }))))
    return saved
  }

  async function save(status) {
    setBusy(true)
    try { await persist(status); toast(t('saved')); onDone() }
    catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }

  async function receive() {
    setBusy(true)
    try {
      await persist()
      const fresh = await q(db.from('purchase_order_lines').select('id,material_id').eq('po_id', po.id))
      const byMat = {}
      L.forEach(l => { byMat[l.material_id] = l })
      const payload = fresh.map(f => {
        const l = byMat[f.material_id] || {}
        return { line_id: f.id, received_qty: l.received_qty ?? l.qty, lot_no: l.lot_no || '', expiry_date: l.expiry_date || '' }
      })
      await q(db.rpc('receive_purchase_order', { p_po_id: po.id, p_lines: payload }))
      toast(t('po_received')); onDone()
    } catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }

  if (!L) return <Modal title="…" onClose={onClose}><Loading /></Modal>
  const total = L.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0)

  return (
    <Modal wide onClose={onClose} title={po.id ? `P${po.no} · ${supName(po.supplier_id)}` : t('newPO')}>
      <div className="form-grid">
        <Field label={t('supplier')}>
          <select value={head.supplier_id || ''} disabled={!editable} onChange={e => setHead({ ...head, supplier_id: e.target.value })}>
            {data.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('date')}><input type="date" disabled={!editable} value={head.order_date || ''} onChange={e => setHead({ ...head, order_date: e.target.value })} /></Field>
        <Field label={t('expected')}><input type="date" disabled={!editable} value={head.expected_date} onChange={e => setHead({ ...head, expected_date: e.target.value })} /></Field>
        <Field label={t('notes')}><input disabled={!editable} value={head.notes} onChange={e => setHead({ ...head, notes: e.target.value })} /></Field>
      </div>

      <div className="table-wrap"><table className="table compact">
        <thead><tr>
          <th>{t('nav_materials')}</th><th className="num">{t('qty')}</th><th className="num">{t('price')}</th>
          {(receiving || po.status === 'received') && <><th className="num">{t('received')}</th><th>{t('lot')}</th><th>{t('expiry')}</th></>}
          <th className="num">{t('total')}</th>{editable && !receiving && <th />}
        </tr></thead>
        <tbody>{L.map((l, i) => (
          <tr key={i}>
            <td>{editable && !l.id ? (
              <select value={l.material_id || ''} onChange={e => {
                const m = mat(e.target.value); setLine(i, { material_id: e.target.value, unit_price: m.cost_per_unit })
              }} aria-label={t('nav_materials')}>
                <option value="">–</option>
                {data.materials.map(m => <option key={m.id} value={m.id}>{t.pick(m)} ({m.unit})</option>)}
              </select>
            ) : <>{t.pick(mat(l.material_id))} <span className="muted">{mat(l.material_id).unit}</span></>}</td>
            <td className="num">{editable ? <NumInput className="input-sm" value={l.qty} onChange={x => setLine(i, { qty: x })} aria-label={t('qty')} /> : fmtNum(l.qty, t.lang)}</td>
            <td className="num">{editable ? <NumInput className="input-sm" value={l.unit_price} onChange={x => setLine(i, { unit_price: x })} aria-label={t('price')} /> : fmtFt(l.unit_price, t.lang)}</td>
            {receiving && <>
              <td className="num"><NumInput className="input-sm" value={l.received_qty} onChange={x => setLine(i, { received_qty: x })} aria-label={t('received')} /></td>
              <td><input className="input-sm" value={l.lot_no} onChange={e => setLine(i, { lot_no: e.target.value })} aria-label={t('lot')} /></td>
              <td><input type="date" className="input-sm" value={l.expiry_date} onChange={e => setLine(i, { expiry_date: e.target.value })} aria-label={t('expiry')} /></td>
            </>}
            {po.status === 'received' && <>
              <td className="num">{fmtNum(l.received_qty, t.lang)}</td><td>{l.lot_no || '–'}</td><td>{fmtDate(l.expiry_date, t.lang)}</td>
            </>}
            <td className="num">{fmtFt((l.qty || 0) * (l.unit_price || 0), t.lang)}</td>
            {editable && !receiving && <td className="act"><button className="btn-icon" aria-label={t('delete')} onClick={() => setLines(L.filter((_, j) => j !== i))}>×</button></td>}
          </tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={2}>
          {editable && !receiving && <button className="btn btn-sm" onClick={() => setLines([...L, { material_id: '', qty: null, unit_price: 0 }])}>{t('addLine')}</button>}
        </td><td colSpan={receiving || po.status === 'received' ? 4 : 1} /><td className="num"><b>{fmtFt(total, t.lang)}</b></td></tr></tfoot>
      </table></div>

      <div className="modal-foot">
        {po.id && editable && <button className="btn btn-danger-quiet" disabled={busy} onClick={() => save('cancelled')}>{t('cancelOrder')}</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('close')}</button>
        {editable && <button className="btn" disabled={busy} onClick={() => save()}>{t('save')}</button>}
        {(!po.id || po.status === 'draft') && <button className="btn btn-primary" disabled={busy} onClick={() => save('ordered')}>{t('markOrdered')}</button>}
        {receiving && <button className="btn btn-primary" disabled={busy} onClick={receive}>{t('receive')}</button>}
      </div>
    </Modal>
  )
}
