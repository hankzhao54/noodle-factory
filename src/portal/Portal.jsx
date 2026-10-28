import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { LangSwitch } from '../App'
import { Loading, ErrorBox, Empty, Status, Tabs, useToast, errText } from '../components/ui'
import QtyPicker, { cartTotal } from '../components/QtyPicker'

export default function Portal() {
  const t = useT()
  const { signOut, profile, isRestaurant } = useAuth()
  const [tab, setTab] = useState('order')
  const [qty, setQty] = useState({})
  const { data, error, reload } = useData(async () => {
    const [me, catalog, orders] = await Promise.all([
      q(db.from('customers').select('*').maybeSingle()),
      q(db.from('my_catalog').select('*').order('sort')),
      q(db.from('orders').select('*, order_lines(id, product_id, qty' + (isRestaurant ? '' : ', unit_price') + ')').order('created_at', { ascending: false }).limit(50)),
    ])
    return { me, catalog, orders }
  })

  return (
    <div className="portal">
      <header className="portal-head">
        <div className="portal-brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{data?.me?.name || t('appName')}</span></div>
        <div className="portal-tools"><LangSwitch /><button className="btn-link" onClick={signOut}>{t('signOut')}</button></div>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={[['order', t('portalOrder')], ['history', t('portalHistory')]]} />
      <ErrorBox error={error} />
      {!data ? <Loading /> : !profile?.customer_id || !data.me ? (
        <p className="note-box">{t('noCustomerLink')}</p>
      ) : tab === 'order' ? (
        <OrderSheet internal={isRestaurant} catalog={data.catalog} me={data.me} qty={qty} setQty={setQty}
          onPlaced={() => { setQty({}); reload(); setTab('history') }} />
      ) : (
        <History internal={isRestaurant} orders={data.orders} catalog={data.catalog} reload={reload}
          onAgain={o => {
            const next = {}
            o.order_lines.forEach(l => { if (data.catalog.some(p => p.id === l.product_id)) next[l.product_id] = Number(l.qty) })
            setQty(next); setTab('order')
          }} />
      )}
    </div>
  )
}

function OrderSheet({ internal, catalog, me, qty, setQty, onPlaced }) {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(todayISO(1))
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const total = cartTotal(catalog, qty)
  const count = Object.keys(qty).length

  async function place() {
    setBusy(true)
    try {
      await q(db.rpc('place_order', {
        p_delivery_date: date, p_notes: notes || null,
        p_lines: Object.entries(qty).map(([product_id, q]) => ({ product_id, qty: q })),
      }))
      toast(t(internal ? 'orderPlacedInternal' : 'orderPlaced')); setNotes(''); onPlaced()
    } catch (e) { toast(errText(e), 'error') } finally { setBusy(false) }
  }

  return (
    <div className="order-sheet">
      <div className="sheet-head">
        <label className="field"><span className="field-label">{t('deliveryDate')}</span>
          <input type="date" min={todayISO()} value={date} onChange={e => setDate(e.target.value)} /></label>
        {me.address && <p className="muted small">{me.address}</p>}
      </div>
      {catalog.length === 0 ? <Empty /> : <QtyPicker items={catalog} qty={qty} setQty={setQty} />}
      <label className="field"><span className="field-label">{t('notes')}</span>
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="cart-bar">
        <div>
          <b>{internal ? t('itemsN', { n: count }) : fmtFt(total, t.lang)}</b>
          <span className="muted small">{internal ? (count ? t('internalOrderNote') : t('emptyCart')) : <>{count ? t('itemsN', { n: count }) : t('emptyCart')} · {t('noPayment')}</>}</span>
        </div>
        <button className="btn btn-primary" disabled={!count || busy} onClick={place}>{t('placeOrder')}</button>
      </div>
    </div>
  )
}

function History({ internal, orders, catalog, reload, onAgain }) {
  const t = useT()
  const toast = useToast()
  const [openId, setOpenId] = useState(null)
  const prod = id => catalog.find(p => p.id === id) || {}
  if (!orders.length) return <Empty />
  async function cancel(o) {
    if (!confirm(t('cancelOrder') + '?')) return
    try { await q(db.rpc('cancel_my_order', { p_order_id: o.id })); toast(t('o_cancelled')); reload() }
    catch (e) { toast(errText(e), 'error') }
  }
  return (
    <ul className="history">
      {orders.map(o => {
        const total = o.order_lines.reduce((s, l) => s + l.qty * (l.unit_price || 0), 0)
        const open = openId === o.id
        return (
          <li key={o.id} className={open ? 'open' : ''}>
            <button className="history-row" aria-expanded={open} onClick={() => setOpenId(open ? null : o.id)}>
              <span className="mono-num">#{o.no}</span>
              <span>{fmtDate(o.delivery_date, t.lang)}</span>
              <Status value={o.status} prefix="o" />
              <span className="num">{internal ? t('itemsN', { n: o.order_lines.length }) : fmtFt(total, t.lang)}</span>
            </button>
            {open && (
              <div className="history-body">
                <ul>{o.order_lines.map(l => (
                  <li key={l.id}><span>{t.pick(prod(l.product_id)) || '–'}</span>
                    <span className="num">{fmtNum(l.qty, t.lang)} {prod(l.product_id).unit}{internal ? '' : ` × ${fmtFt(l.unit_price, t.lang)}`}</span></li>
                ))}</ul>
                {o.notes && <p className="muted small">{o.notes}</p>}
                <div className="row-gap">
                  <button className="btn btn-sm" onClick={() => onAgain(o)}>{t('orderAgain')}</button>
                  {o.status === 'submitted' && <button className="btn btn-sm btn-danger-quiet" onClick={() => cancel(o)}>{t('cancelOrder')}</button>}
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
