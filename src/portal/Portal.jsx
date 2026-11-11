import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { LangSwitch } from '../App'
import { Loading, ErrorBox, Empty, Status, Tabs, NumInput, useToast, errText } from '../components/ui'
import QtyPicker, { cartTotal } from '../components/QtyPicker'
import { dateProblem, nextDates, deliveryDays, dayName } from '../lib/orderRules'
import InstallHint from '../components/InstallHint'
import { LegalLinks } from '../legal/LegalPage'
import { usePublicInfo } from '../lib/publicInfo'

export default function Portal() {
  const t = useT()
  const { signOut, profile, isRestaurant, reloadProfile } = useAuth()
  const info = usePublicInfo()
  // external customers must accept the current terms before ordering (place_order checks it too)
  const needTerms = profile?.role === 'customer' && info && profile.terms_version !== info.terms_version
  const [tab, setTab] = useState('order')
  const [qty, setQty] = useState({})
  const { data, error, reload } = useData(async () => {
    const [me, catalog, orders, rules, pinfo, editInfo] = await Promise.all([
      q(db.from('customers').select('*').maybeSingle()),
      q(db.from('my_catalog').select('*').order('sort')),
      q(db.from('orders').select('id, no, status, delivery_date, notes, created_at, delivered_at, received_by, store:customer_locations(name), order_lines(id, product_id, qty' + (isRestaurant ? '' : ', unit_price') + ')').order('created_at', { ascending: false }).limit(50)),
      q(db.rpc('order_rules')).catch(() => null),
      q(db.rpc('product_info')).catch(() => null),
      q(db.rpc('my_order_edit_info')).catch(() => ({})),
    ])
    return { me, catalog, orders, rules, pinfo, editInfo: editInfo || {} }
  })

  return (
    <div className="portal">
      <header className="portal-head">
        <div className="portal-brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{data?.me?.name || t('appName')}{data?.rules?.my_location && data.rules.locations?.[0] ? ` · ${data.rules.locations[0].name}` : ''}</span></div>
        <div className="portal-tools"><LangSwitch /><button className="btn-link" onClick={signOut}>{t('signOut')}</button></div>
      </header>
      <CustomerSwitch />
      <InstallHint />
      {needTerms && <TermsBanner first={!profile.terms_version} onDone={reloadProfile} />}
      {isRestaurant && data?.orders && <ToReceive orders={data.orders} catalog={data.catalog} reload={reload} />}
      <Tabs value={tab} onChange={setTab} tabs={[['order', t('portalOrder')], ['history', t('portalHistory')]]} />
      <ErrorBox error={error} />
      {!data ? <Loading /> : !profile?.customer_id || !data.me ? (
        <p className="note-box">{t('noCustomerLink')}</p>
      ) : tab === 'order' ? (
        <OrderSheet blocked={needTerms} info={info} pinfo={data.pinfo} internal={isRestaurant} catalog={data.catalog} me={data.me} rules={data.rules} qty={qty} setQty={setQty}
          onPlaced={() => { setQty({}); reload(); setTab('history') }} />
      ) : (
        <History internal={isRestaurant} orders={data.orders} catalog={data.catalog} editInfo={data.editInfo} reload={reload}
          onAgain={o => {
            const next = {}
            o.order_lines.forEach(l => { if (data.catalog.some(p => p.id === l.product_id)) next[l.product_id] = Number(l.qty) })
            setQty(next); setTab('order')
          }} />
      )}
      <LegalLinks className="portal-legal" />
    </div>
  )
}

function TermsBanner({ first, onDone }) {
  const t = useT()
  const toast = useToast()
  const [agree, setAgree] = useState(false)
  async function accept() {
    try { await q(db.rpc('accept_terms')); onDone() } catch (e) { toast(errText(e), 'error') }
  }
  return (
    <div className="note-box terms-banner" role="region" aria-label={t('legalTerms')}>
      <p><b>{t(first ? 'termsFirst' : 'termsChanged')}</b></p>
      <label className="check-line"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
        <span>{t('acceptTermsPre')} <a href="/legal/aszf" target="_blank" rel="noopener">{t('legalTerms')}</a> {t('acceptTermsMid')} <a href="/legal/adatvedelem" target="_blank" rel="noopener">{t('legalPrivacy')}</a> {t('acceptTermsPost')}</span></label>
      <button type="button" className="btn btn-primary btn-sm" disabled={!agree} onClick={accept}>{t('acceptTerms')}</button>
    </div>
  )
}

const STORE_KEY = 'nf-store'
function OrderSheet({ blocked, info, pinfo, internal, catalog, me, rules: baseRules, qty, setQty, onPlaced }) {
  const t = useT()
  const toast = useToast()
  // companies with several stores: pick the store first (store accounts are fixed to theirs)
  const stores = baseRules?.locations || []
  const [storeId, setStoreId] = useState(() => {
    if (stores.length === 1) return stores[0].id
    let last = null; try { last = localStorage.getItem(STORE_KEY) } catch { /* ignore */ }
    return stores.some(l => l.id === last) ? last : ''
  })
  const store = stores.find(l => l.id === storeId)
  // the store's delivery weekdays (if set) replace the company's
  const rules = baseRules && store?.weekdays?.length ? { ...baseRules, my_weekdays: store.weekdays } : baseRules
  const options = nextDates(rules, 6)
  const [date, setDate] = useState(() => options[0] || todayISO(1))
  function pickStore(id) {
    setStoreId(id); try { localStorage.setItem(STORE_KEY, id) } catch { /* ignore */ }
    const l = stores.find(x => x.id === id)
    const r = baseRules && l?.weekdays?.length ? { ...baseRules, my_weekdays: l.weekdays } : baseRules
    if (dateProblem(r, date)) setDate(nextDates(r, 1)[0] || date)
  }
  const needStore = stores.length > 0 && !store
  const problem = dateProblem(rules, date)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const total = cartTotal(catalog, qty)
  const count = Object.keys(qty).length

  async function place() {
    setBusy(true)
    try {
      await q(db.rpc('place_order', {
        p_delivery_date: date, p_notes: notes || null, p_location_id: storeId || null,
        p_lines: Object.entries(qty).map(([product_id, q]) => ({ product_id, qty: q })),
      }))
      toast(t(internal ? 'orderPlacedInternal' : 'orderPlaced')); setNotes(''); onPlaced()
    } catch (e) {
      const m = /delivery date not allowed: (\w+)/.exec(e?.message || '')
      toast(m ? t('dp_' + m[1]) : errText(e), 'error')
    } finally { setBusy(false) }
  }
  const days = rules ? deliveryDays(rules).map(d => dayName(t.lang, d)).join(', ') : ''

  return (
    <div className="order-sheet">
      <div className="sheet-head">
        {stores.length > 1 && <>
          <span className="field-label">{t('deliverTo')}</span>
          <div className="date-chips" role="radiogroup" aria-label={t('deliverTo')}>
            {stores.map(l => (
              <button key={l.id} type="button" role="radio" aria-checked={l.id === storeId}
                className={l.id === storeId ? 'chip on' : 'chip'} onClick={() => pickStore(l.id)}>{l.name}</button>
            ))}
          </div>
          {needStore && <p className="muted small">{t('pickStore')}</p>}
        </>}
        <span className="field-label">{t('deliveryDate')}</span>
        {options.length > 0 && (
          <div className="date-chips" role="radiogroup" aria-label={t('deliveryDate')}>
            {options.map(d => (
              <button key={d} type="button" role="radio" aria-checked={d === date}
                className={d === date ? 'chip on' : 'chip'} onClick={() => setDate(d)}>{fmtDate(d, t.lang)}</button>
            ))}
          </div>
        )}
        <label className="field date-other"><span className="muted small">{t('otherDate')}</span>
          <input type="date" min={rules?.earliest || todayISO()} value={date} onChange={e => setDate(e.target.value)} /></label>
        {problem && <p className="error-box small">{t('dp_' + problem)}</p>}
        {rules && <p className="muted small">{t('rulesNote', { cutoff: rules.cutoff || '–', days })}</p>}
        {(store ? store.address : me.address) && <p className="muted small">{store ? `${store.name} · ${store.address}` : me.address}</p>}
      </div>
      {catalog.length === 0 ? <Empty /> : <QtyPicker items={catalog} qty={qty} setQty={setQty} info={pinfo}
        producer={info ? [info.company_name, info.company_address].filter(Boolean).join(', ') : null} />}
      <label className="field"><span className="field-label">{t('notes')}</span>
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="cart-bar">
        <div>
          <b>{internal ? t('itemsN', { n: count }) : `${fmtFt(total, t.lang)} ${t('netPrice')}`}</b>
          <span className="muted small">{internal ? (count ? t('internalOrderNote') : t('emptyCart')) : <>{count ? t('itemsN', { n: count }) : t('emptyCart')} · {t('noPayment')}</>}</span>
        </div>
        <button className="btn btn-primary" disabled={!count || busy || !!problem || blocked || needStore} onClick={place}>{t('placeOrder')}</button>
      </div>
    </div>
  )
}

function History({ internal, orders, catalog, editInfo, reload, onAgain }) {
  const t = useT()
  const toast = useToast()
  const [openId, setOpenId] = useState(null)
  const [ask, setAsk] = useState(null)        // 'order:<id>' waiting for the second tap
  const [editing, setEditing] = useState(null) // order id being changed
  const [draft, setDraft] = useState({})       // line id → qty (0 = cancel)
  const [busy, setBusy] = useState(false)
  const prod = id => catalog.find(p => p.id === id) || {}
  if (!orders.length) return <Empty />
  async function cancel(o) {
    try { await q(db.rpc('cancel_my_order', { p_order_id: o.id })); setAsk(null); toast(t('o_cancelled')); reload() }
    catch (e) { setAsk(null); toast(/can no longer/.test(e.message || '') ? t('cantChangeNow') : errText(e), 'error') }
  }
  async function save(o) {
    const changes = o.order_lines.filter(l => l.id in draft && Number(draft[l.id] || 0) !== Number(l.qty))
      .map(l => ({ line_id: l.id, qty: Number(draft[l.id] || 0) }))
    if (!changes.length) { setEditing(null); return }
    setBusy(true)
    try {
      const r = await q(db.rpc('edit_my_order', { p_order: o.id, p_changes: changes }))
      toast(r?.cancelled ? t('o_cancelled') : t('orderChanged')); setEditing(null); setDraft({}); reload()
    } catch (e) {
      toast(/production planned|can no longer/.test(e.message || '') ? t('cantChangeNow') : errText(e), 'error')
    } finally { setBusy(false) }
  }
  return (
    <ul className="history">
      {orders.map(o => {
        const total = o.order_lines.reduce((s, l) => s + l.qty * (l.unit_price || 0), 0)
        const open = openId === o.id
        const info = editInfo?.[o.id]                       // present = this account may still change it
        const locked = new Set(info?.locked || [])
        const isEditing = editing === o.id
        const q0 = l => (l.id in draft ? draft[l.id] : Number(l.qty))
        return (
          <li key={o.id} className={open ? 'open' : ''}>
            <button className="history-row" aria-expanded={open} onClick={() => { setOpenId(open ? null : o.id); setEditing(null); setDraft({}) }}>
              <span className="mono-num">#{o.no}</span>
              <span>{fmtDate(o.delivery_date, t.lang)}{o.store ? <span className="muted"> · {o.store.name}</span> : ''}</span>
              <Status value={o.status} prefix="o" />
              <span className="num">{internal ? t('itemsN', { n: o.order_lines.length }) : `${fmtFt(total, t.lang)} ${t('netPrice')}`}</span>
            </button>
            {open && (
              <div className="history-body">
                <ul>{o.order_lines.map(l => {
                  const gone = isEditing && !(Number(q0(l)) > 0)
                  return (
                  <li key={l.id} className={gone ? 'line-gone' : ''}><span>{t.pick(prod(l.product_id)) || '–'}</span>
                    <span className="num">
                      {isEditing && internal && !locked.has(l.id) && !gone
                        ? <><NumInput className="input-sm" value={q0(l)} min={0} aria-label={`${t('qty')} ${t.pick(prod(l.product_id))}`}
                            onChange={v => setDraft(d => ({ ...d, [l.id]: v ?? 0 }))} /> {prod(l.product_id).unit}</>
                        : <>{fmtNum(isEditing ? q0(l) : l.qty, t.lang)} {prod(l.product_id).unit}{internal ? '' : ` × ${fmtFt(l.unit_price, t.lang)}`}</>}
                      {isEditing && (locked.has(l.id)
                        ? <span className="muted small"> 🔒 {t('productionPlanned')}</span>
                        : gone
                          ? <button className="btn-link small" onClick={() => setDraft(d => ({ ...d, [l.id]: Number(l.qty) }))}> {t('undo')}</button>
                          : <button className="btn-link small danger" onClick={() => setDraft(d => ({ ...d, [l.id]: 0 }))} aria-label={`${t('cancelLine')} ${t.pick(prod(l.product_id))}`}> ✕</button>)}
                    </span></li>)
                })}</ul>
                {o.notes && <p className="muted small">{o.notes}</p>}
                {isEditing && <p className="muted small">{t(internal ? 'myEditHintInternal' : 'myEditHintExternal')}</p>}
                <div className="row-gap">
                  {isEditing ? <>
                    <button className="btn btn-sm" onClick={() => { setEditing(null); setDraft({}) }}>{t('cancel')}</button>
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => save(o)}>{t('saveChanges')}</button>
                  </> : <>
                    <button className="btn btn-sm" onClick={() => onAgain(o)}>{t('orderAgain')}</button>
                    {info && <button className="btn btn-sm" onClick={() => { setEditing(o.id); setDraft({}) }}>{t(internal ? 'changeOrder' : 'cancelItems')}</button>}
                    {info && !locked.size && (ask === 'order:' + o.id
                      ? <button className="btn btn-sm btn-danger" onClick={() => cancel(o)}>{t('cancelOrderConfirm')}</button>
                      : <button className="btn btn-sm btn-danger-quiet" onClick={() => setAsk('order:' + o.id)}>{t('cancelOrder')}</button>)}
                  </>}
                </div>
                {o.status === 'delivered' && o.delivered_at && <p className="muted small">✓ {t('receivedAt')} {fmtDateTime(o.delivered_at, t.lang)}{o.received_by ? ` · ${o.received_by}` : ''}</p>}
                {internal && o.status === 'confirmed' && !info && o.delivery_date >= todayISO() && <p className="muted small">{t('cantChangeNow')}</p>}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// own restaurants: orders due today (or earlier) that have not been marked delivered — one tap when they arrive
function ToReceive({ orders, catalog, reload }) {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const today = todayISO()
  const due = orders.filter(o => ['submitted', 'confirmed', 'ready'].includes(o.status) && o.delivery_date <= today)
  if (!due.length) return null
  const prod = id => catalog.find(p => p.id === id) || {}
  async function confirm(o) {
    setBusy(o.id)
    try { await q(db.rpc('confirm_my_receipt', { p_order: o.id })); toast(t('receiptConfirmed')); reload() }
    catch (e) { toast(errText(e), 'error') }
    finally { setBusy(null) }
  }
  return (
    <section className="to-receive" aria-label={t('toReceive')}>
      <h2>{t('toReceive')}</h2>
      {due.map(o => (
        <div key={o.id} className="to-receive-card">
          <div className="to-receive-text">
            <b>#{o.no} · {fmtDate(o.delivery_date, t.lang)}{o.store ? ` · ${o.store.name}` : ''}</b>
            <span className="muted small">{o.order_lines.map(l => `${t.pick(prod(l.product_id)) || '–'} ${fmtNum(l.qty, t.lang)} ${prod(l.product_id).unit || ''}`).join(' · ')}</span>
          </div>
          <button className="btn btn-primary" disabled={busy === o.id} onClick={() => confirm(o)}>✓ {t('confirmReceipt')}</button>
        </div>
      ))}
    </section>
  )
}

const fmtDateTime = (d, lang) => new Date(d).toLocaleString({ zh: 'zh-CN', en: 'en-GB', hu: 'hu-HU' }[lang], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// accounts linked to several customers (e.g. own restaurant + an external customer): pick who you order for.
// Switching changes prices, order history and delivery rules to that customer's.
function CustomerSwitch() {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const { data } = useData(() => q(db.rpc('my_customers')))
  if (!data || data.length < 2) return null
  const cur = data.find(c => c.current)
  async function pick(id) {
    if (id === cur?.id) return
    setBusy(true)
    try { await q(db.rpc('switch_customer', { p_customer: id })); window.location.reload() }
    catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }
  return (
    <div className="customer-switch" role="group" aria-label={t('orderingFor')}>
      <span className="field-label">{t('orderingFor')}</span>
      <div className="date-chips">
        {data.map(c => (
          <button key={c.id} type="button" disabled={busy} aria-pressed={c.current} className={c.current ? 'chip on' : 'chip'} onClick={() => pick(c.id)}>
            {c.name}{c.store ? ` · ${c.store}` : ''}{c.type === 'internal' ? ` (${t('internal')})` : ''}
          </button>
        ))}
      </div>
    </div>
  )
}
