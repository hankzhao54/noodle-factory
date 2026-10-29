import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Status, Tabs, useToast, errText } from '../components/ui'
import QtyPicker, { cartTotal } from '../components/QtyPicker'

export default function Orders() {
  const t = useT()
  const [tab, setTab] = useState('open')
  const [from, setFrom] = useState(todayISO(-7))
  const [detail, setDetail] = useState(null)
  const [creating, setCreating] = useState(false)
  const { data, loading, error, reload } = useData(async () => {
    const [orders, customers, products] = await Promise.all([
      q(db.from('orders').select('*, order_lines(*)').gte('delivery_date', from).order('delivery_date').order('created_at')),
      q(db.from('customers').select('id,name,type').order('name')),
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,base_price,min_order_qty,pack_size_g,active,sort,image_path').order('sort')),
    ])
    return { orders, customers, products }
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
        <label className="inline-field">{t('deliveryDate')} ≥ <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>{t('newOrder')}</button>
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[
        ['open', t('openOrders')],
        ['submitted', `${t('o_submitted')}${newCount ? ` (${newCount})` : ''}`],
        ['confirmed', t('o_confirmed')], ['delivered', t('o_delivered')], ['all', t('all')],
      ]} />
      {shown.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>#</th><th>{t('deliveryDate')}</th><th>{t('customer')}</th><th>{t('lines')}</th>
            <th className="num">{t('total')}</th><th>{t('status')}</th></tr></thead>
          <tbody>{shown.map(o => (
            <tr key={o.id} className="clickable" onClick={() => setDetail(o)}>
              <td className="mono-num">#{o.no}</td>
              <td className="nowrap">{fmtDate(o.delivery_date, t.lang)}</td>
              <td><b>{cust(o.customer_id).name}</b> {cust(o.customer_id).type === 'internal' && <span className="tag tag-internal">{t('internal')}</span>}</td>
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
      {creating && <NewOrder customers={data.customers} products={data.products}
        onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload() }} />}
    </div>
  )
}

export function OrderDetail({ order, customer, products, onClose, onDone, readOnly }) {
  const t = useT()
  const toast = useToast()
  const prod = id => products.find(p => p.id === id) || {}
  const total = order.order_lines.reduce((s, l) => s + l.qty * l.unit_price, 0)
  const setStatus = async status => {
    try {
      await q(db.from('orders').update({ status }).eq('id', order.id))
      toast(t('o_' + status)); onDone()
    } catch (e) { toast(errText(e), 'error') }
  }
  return (
    <Modal title={`#${order.no} · ${customer?.name || ''}`} onClose={onClose}>
      <div className="detail-meta">
        <Status value={order.status} prefix="o" />
        <span>{t('deliveryDate')}: <b>{fmtDate(order.delivery_date, t.lang)}</b></span>
      </div>
      <table className="table compact">
        <thead><tr><th>{t('name')}</th><th className="num">{t('qty')}</th><th className="num">{t('price')}</th><th className="num">{t('total')}</th></tr></thead>
        <tbody>{order.order_lines.map(l => (
          <tr key={l.id}><td>{t.pick(prod(l.product_id))}</td>
            <td className="num">{fmtNum(l.qty, t.lang)} <span className="unit">{prod(l.product_id).unit}</span></td>
            <td className="num muted">{fmtFt(l.unit_price, t.lang)}</td>
            <td className="num">{fmtFt(l.qty * l.unit_price, t.lang)}</td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={3}>{t('total')}</td><td className="num"><b>{fmtFt(total, t.lang)}</b></td></tr></tfoot>
      </table>
      {order.notes && <p className="note-box">{order.notes}</p>}
      {!readOnly && (
        <div className="modal-foot">
          {['submitted', 'confirmed', 'ready'].includes(order.status) &&
            <button className="btn btn-danger-quiet" onClick={() => confirm(t('cancelOrder') + '?') && setStatus('cancelled')}>{t('cancelOrder')}</button>}
          <span className="grow" />
          {order.status === 'submitted' && <button className="btn btn-primary" onClick={() => setStatus('confirmed')}>{t('confirm')}</button>}
          {order.status === 'confirmed' && <button className="btn btn-primary" onClick={() => setStatus('ready')}>{t('markReady')}</button>}
        </div>
      )}
    </Modal>
  )
}

function NewOrder({ customers, products, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [customerId, setCustomerId] = useState('')
  const [date, setDate] = useState(todayISO(1))
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState({})
  const { data: prices } = useData(() => customerId
    ? q(db.from('customer_prices').select('*').eq('customer_id', customerId)) : Promise.resolve([]), [customerId])
  const items = products.filter(p => p.active).map(p => ({
    ...p, price: prices?.find(x => x.product_id === p.id)?.price ?? p.base_price,
  }))
  async function save() {
    try {
      await q(db.rpc('place_order', {
        p_delivery_date: date, p_notes: notes || null, p_customer_id: customerId,
        p_lines: Object.entries(qty).map(([product_id, q]) => ({ product_id, qty: q })),
      }))
      toast(t('saved')); onDone()
    } catch (e) { toast(errText(e), 'error') }
  }
  return (
    <Modal wide title={t('newOrder')} onClose={onClose}>
      <div className="form-grid">
        <Field label={t('customer')}>
          <select value={customerId} onChange={e => setCustomerId(e.target.value)} required>
            <option value="">–</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={t('deliveryDate')}><input type="date" min={todayISO()} value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label={t('notes')} span={2}><input value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </div>
      {customerId && <QtyPicker items={items} qty={qty} setQty={setQty} />}
      <div className="modal-foot">
        <b>{t('total')}: {fmtFt(cartTotal(items, qty), t.lang)}</b>
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={!customerId || !Object.keys(qty).length} onClick={save}>{t('placeOrder')}</button>
      </div>
    </Modal>
  )
}
