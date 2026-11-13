import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Status, Tabs, NumInput, useToast, errText } from '../components/ui'
import QtyPicker, { cartTotal } from '../components/QtyPicker'

export default function Orders() {
  const t = useT()
  const [tab, setTab] = useState('open')
  const [from, setFrom] = useState('')          // optional: only orders delivered on/after this day
  const [detail, setDetail] = useState(null)
  const [creating, setCreating] = useState(false)
  const { data, loading, error, reload } = useData(async () => {
    const [orders, customers, products, stores] = await Promise.all([
      // newest orders first; the delivery-date filter is optional
      q((from ? db.from('orders').select('*, order_lines(*), store:customer_locations(name,address)').gte('delivery_date', from)
              : db.from('orders').select('*, order_lines(*), store:customer_locations(name,address)'))
        .order('created_at', { ascending: false }).limit(500)),
      q(db.from('customers').select('id,name,type').order('name')),
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,base_price,min_order_qty,pack_size_g,active,sort,image_path').order('sort')),
      q(db.from('customer_locations').select('id,customer_id,name').eq('active', true).order('sort').order('name')),
    ])
    return { orders, customers, products, stores }
  }, [from])

  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>
  const cust = id => data.customers.find(c => c.id === id) || {}
  const shown = data.orders.filter(o => tab === 'all' || (tab === 'open' ? ['submitted', 'confirmed', 'ready'].includes(o.status) : o.status === tab))
  const total = o => o.order_lines.reduce((s, l) => s + l.qty * l.unit_price, 0)
  const newCount = data.orders.filter(o => o.status === 'submitted').length

  return (
    <div className="page">
      <PageHead title={t('nav_orders')}>
        <label className="inline-field">{t('deliveryDate')} ≥ <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          {from && <button type="button" className="btn-link small" onClick={() => setFrom('')}>{t('all')}</button>}</label>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>{t('newOrder')}</button>
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[
        ['open', t('openOrders')],
        ['submitted', `${t('o_submitted')}${newCount ? ` (${newCount})` : ''}`],
        ['confirmed', t('o_confirmed')], ['delivered', t('o_delivered')], ['all', t('all')],
      ]} />
      {shown.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>#</th><th>{t('orderedAt')}</th><th>{t('deliveryDate')}</th><th>{t('customer')}</th><th>{t('lines')}</th>
            <th className="num">{t('total')}</th><th>{t('status')}</th></tr></thead>
          <tbody>{shown.map(o => (
            <tr key={o.id} className="clickable" onClick={() => setDetail(o)}>
              <td className="mono-num">#{o.no}</td>
              <td className="nowrap muted small">{new Date(o.created_at).toLocaleString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="nowrap">{fmtDate(o.delivery_date, t.lang)}</td>
              <td><b>{cust(o.customer_id).name}</b> {cust(o.customer_id).type === 'internal' && <span className="tag tag-internal">{t('internal')}</span>}
                {o.urgent && <span className="tag tag-urgent">🚨 {t('urgent')}</span>}
                {o.store && <div className="muted small">{o.store.name}</div>}</td>
              <td className="muted small">{o.order_lines.map(l => {
                const p = data.products.find(x => x.id === l.product_id) || {}
                return `${t.pick(p)} ${fmtNum(l.qty, t.lang)}${p.unit || ''}`
              }).join(', ')}</td>
              <td className="num">{fmtFt(total(o), t.lang)}</td>
              <td><Status value={o.status} prefix="o" /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {detail && <OrderDetail order={detail} customer={cust(detail.customer_id)} products={data.products}
        onClose={() => setDetail(null)} onDone={() => { setDetail(null); reload() }} />}
      {creating && <NewOrder customers={data.customers} products={data.products} stores={data.stores}
        onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload() }} />}
    </div>
  )
}

export function OrderDetail({ order, customer, products, onClose, onDone, readOnly }) {
  const t = useT()
  const toast = useToast()
  const prod = id => products.find(p => p.id === id) || {}
  const [askCancel, setAskCancel] = useState(false)
  const [mode, setMode] = useState('view')                 // view | edit | split | date
  const [newDate, setNewDate] = useState(() => order.delivery_date < todayISO() ? todayISO() : order.delivery_date)
  const [edit, setEdit] = useState({})                     // line id → new qty (0 = cancel this product)
  const [pick, setPick] = useState([])                     // line ids to move (split)
  const [splitDate, setSplitDate] = useState(() => { const d = new Date(order.delivery_date + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10) })
  const [busy, setBusy] = useState(false)
  const changeable = !readOnly && ['submitted', 'confirmed', 'ready'].includes(order.status)
  const qtyOf = l => (l.id in edit ? edit[l.id] : Number(l.qty))
  const total = order.order_lines.reduce((s, l) => s + (mode === 'edit' ? qtyOf(l) || 0 : l.qty) * l.unit_price, 0)
  async function saveEdit() {
    const changes = order.order_lines.filter(l => l.id in edit && Number(edit[l.id] || 0) !== Number(l.qty))
      .map(l => ({ line_id: l.id, qty: Number(edit[l.id] || 0) }))
    if (!changes.length) return setMode('view')
    setBusy(true)
    try {
      const r = await q(db.rpc('edit_order_lines', { p_order: order.id, p_changes: changes }))
      toast(r?.cancelled ? t('o_cancelled') : t('orderChanged')); onDone()
    } catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }
  async function doSplit() {
    setBusy(true)
    try {
      await q(db.rpc('split_order', { p_order: order.id, p_lines: pick, p_delivery_date: splitDate }))
      toast(t('orderSplitDone')); onDone()
    } catch (e) { toast(/keep at least one/.test(e.message || '') ? t('splitKeepOne') : errText(e), 'error'); setBusy(false) }
  }
  async function doMoveDate() {
    setBusy(true)
    try {
      await q(db.rpc('change_order_date', { p_order: order.id, p_date: newDate }))
      toast(t('orderDateChanged')); onDone()
    } catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }
  const setStatus = async status => {
    try {
      await q(db.from('orders').update({ status }).eq('id', order.id))
      toast(t('o_' + status)); onDone()
    } catch (e) { toast(errText(e), 'error') }
  }
  return (
    <Modal title={`#${order.no} · ${customer?.name || ''}${order.store ? ` · ${order.store.name}` : ''}`} onClose={onClose}>
      <div className="detail-meta">
        <Status value={order.status} prefix="o" />
        {order.urgent && <span className="tag tag-urgent">🚨 {t('urgent')}</span>}
        <span>{t('deliveryDate')}: <b>{fmtDate(order.delivery_date, t.lang)}</b></span>
        {order.store?.address && <span className="muted">{order.store.address}</span>}
      </div>
      {mode !== 'view' && <p className="note-box small">{t(mode === 'edit' ? 'editOrderHint' : mode === 'date' ? 'changeDateHint' : 'splitOrderHint')}</p>}
      <table className="table compact">
        <thead><tr>{mode === 'split' && <th />}<th>{t('name')}</th><th className="num">{t('qty')}</th><th className="num">{t('price')}</th><th className="num">{t('total')}</th>{mode === 'edit' && <th />}</tr></thead>
        <tbody>{order.order_lines.map(l => {
          const q0 = mode === 'edit' ? qtyOf(l) : Number(l.qty)
          const gone = mode === 'edit' && !(Number(q0) > 0)
          return (
          <tr key={l.id} className={gone ? 'line-gone' : ''}>
            {mode === 'split' && <td><input type="checkbox" checked={pick.includes(l.id)} aria-label={t.pick(prod(l.product_id))}
              onChange={e => setPick(p => e.target.checked ? [...p, l.id] : p.filter(x => x !== l.id))} /></td>}
            <td>{t.pick(prod(l.product_id))}</td>
            <td className="num">{mode === 'edit'
              ? <NumInput className="input-sm" value={q0} min={0} onChange={v => setEdit(e => ({ ...e, [l.id]: v ?? 0 }))} aria-label={`${t('qty')} ${t.pick(prod(l.product_id))}`} />
              : fmtNum(l.qty, t.lang)} <span className="unit">{prod(l.product_id).unit}</span></td>
            <td className="num muted">{fmtFt(l.unit_price, t.lang)}</td>
            <td className="num">{fmtFt((Number(q0) || 0) * l.unit_price, t.lang)}</td>
            {mode === 'edit' && <td>{gone
              ? <button type="button" className="btn-link small" onClick={() => setEdit(e => ({ ...e, [l.id]: Number(l.qty) }))}>{t('undo')}</button>
              : <button type="button" className="btn-link small danger" onClick={() => setEdit(e => ({ ...e, [l.id]: 0 }))}>{t('cancelLine')}</button>}</td>}
          </tr>)
        })}</tbody>
        <tfoot><tr><td colSpan={3}>{t('total')}</td><td className="num"><b>{fmtFt(total, t.lang)}</b></td></tr></tfoot>
      </table>
      {order.notes && <p className="note-box">{order.notes}</p>}
      {mode === 'edit' && (
        <div className="modal-foot">
          <span className="grow" />
          <button className="btn" onClick={() => { setMode('view'); setEdit({}) }}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={saveEdit}>{t('saveChanges')}</button>
        </div>)}
      {mode === 'split' && (
        <div className="modal-foot">
          <label className="row-gap small">{t('newDeliveryDate')}
            <input type="date" value={splitDate} min={todayISO()} onChange={e => setSplitDate(e.target.value)} /></label>
          <span className="grow" />
          <button className="btn" onClick={() => { setMode('view'); setPick([]) }}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !pick.length || pick.length === order.order_lines.length || !splitDate} onClick={doSplit}>{t('moveToNewOrder')}</button>
        </div>)}
      {mode === 'date' && (
        <div className="modal-foot">
          <label className="row-gap small">{t('newDeliveryDate')}
            <input type="date" value={newDate} min={todayISO()} onChange={e => setNewDate(e.target.value)} /></label>
          <span className="grow" />
          <button className="btn" onClick={() => setMode('view')}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !newDate || newDate === order.delivery_date} onClick={doMoveDate}>{t('saveChanges')}</button>
        </div>)}
      {mode === 'view' && changeable && (
        <div className="row-gap" style={{ marginTop: 8 }}>
          <button className="btn btn-sm" onClick={() => setMode('edit')}>{t('editOrder')}</button>
          <button className="btn btn-sm" onClick={() => setMode('date')}>{t('changeDate')}</button>
          {order.order_lines.length > 1 && <button className="btn btn-sm" onClick={() => setMode('split')}>{t('splitOrder')}</button>}
        </div>)}
      {!readOnly && mode === 'view' && (
        <div className="modal-foot">
          {['submitted', 'confirmed', 'ready'].includes(order.status) &&
            (askCancel
              ? <button className="btn btn-danger" onClick={() => setStatus('cancelled')}>{t('cancelOrderConfirm')}</button>
              : <button className="btn btn-danger-quiet" onClick={() => setAskCancel(true)}>{t('cancelOrder')}</button>)}
          <span className="grow" />
          {order.status === 'submitted' && <button className="btn btn-primary" onClick={() => setStatus('confirmed')}>{t('confirm')}</button>}
          {order.status === 'confirmed' && <button className="btn btn-primary" onClick={() => setStatus('ready')}>{t('markReady')}</button>}
        </div>
      )}
    </Modal>
  )
}

function NewOrder({ customers, products, stores, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [customerId, setCustomerId] = useState('')
  const [storeId, setStoreId] = useState('')
  const myStores = stores.filter(l => l.customer_id === customerId)
  const [date, setDate] = useState(todayISO(1))
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState({})
  const { data: prices } = useData(() => customerId
    ? q(db.rpc('prices_for_customer', { p_customer: customerId })) : Promise.resolve([]), [customerId])
  const items = products.filter(p => p.active).map(p => ({
    ...p, price: prices?.find(x => x.product_id === p.id)?.price ?? p.base_price,
  }))
  async function save() {
    try {
      await q(db.rpc('place_order', {
        p_delivery_date: date, p_notes: notes || null, p_customer_id: customerId, p_location_id: storeId || null,
        p_lines: Object.entries(qty).map(([product_id, q]) => ({ product_id, qty: q })),
      }))
      toast(t('saved')); onDone()
    } catch (e) { toast(errText(e), 'error') }
  }
  return (
    <Modal wide title={t('newOrder')} onClose={onClose}>
      <div className="form-grid">
        <Field label={t('customer')}>
          <select value={customerId} onChange={e => { setCustomerId(e.target.value); setStoreId('') }} required>
            <option value="">–</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {myStores.length > 0 && <Field label={t('store')}>
          <select value={storeId} onChange={e => setStoreId(e.target.value)} required className={!storeId ? 'is-missing' : ''}>
            <option value="">–</option>
            {myStores.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></Field>}
        <Field label={t('deliveryDate')}><input type="date" min={todayISO()} value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label={t('notes')} span={2}><input value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </div>
      {customerId && <QtyPicker items={items} qty={qty} setQty={setQty} />}
      <div className="modal-foot">
        <b>{t('total')}: {fmtFt(cartTotal(items, qty), t.lang)}</b>
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={!customerId || (myStores.length > 0 && !storeId) || !Object.keys(qty).length} onClick={save}>{t('placeOrder')}</button>
      </div>
    </Modal>
  )
}
