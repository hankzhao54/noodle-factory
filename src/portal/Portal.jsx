import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { LangSwitch } from '../App'
import { Loading, ErrorBox, Empty, Status, Tabs, useToast, errText } from '../components/ui'
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
    const [me, catalog, orders, rules, pinfo] = await Promise.all([
      q(db.from('customers').select('*').maybeSingle()),
      q(db.from('my_catalog').select('*').order('sort')),
      q(db.from('orders').select('id, no, status, delivery_date, notes, created_at, store:customer_locations(name), order_lines(id, product_id, qty' + (isRestaurant ? '' : ', unit_price') + ')').order('created_at', { ascending: false }).limit(50)),
      q(db.rpc('order_rules')).catch(() => null),
      q(db.rpc('product_info')).catch(() => null),
    ])
    return { me, catalog, orders, rules, pinfo }
  })

  return (
    <div className="portal">
      <header className="portal-head">
        <div className="portal-brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{data?.me?.name || t('appName')}{data?.rules?.my_location && data.rules.locations?.[0] ? ` · ${data.rules.locations[0].name}` : ''}</span></div>
        <div className="portal-tools"><LangSwitch /><button className="btn-link" onClick={signOut}>{t('signOut')}</button></div>
      </header>
      <InstallHint />
      {needTerms && <TermsBanner first={!profile.terms_version} onDone={reloadProfile} />}
      <Tabs value={tab} onChange={setTab} tabs={[['order', t('portalOrder')], ['history', t('portalHistory')]]} />
      <ErrorBox error={error} />
      {!data ? <Loading /> : !profile?.customer_id || !data.me ? (
        <p className="note-box">{t('noCustomerLink')}</p>
      ) : tab === 'order' ? (
        <OrderSheet blocked={needTerms} info={info} pinfo={data.pinfo} internal={isRestaurant} catalog={data.catalog} me={data.me} rules={data.rules} qty={qty} setQty={setQty}
          onPlaced={() => { setQty({}); reload(); setTab('history') }} />
      ) : (
        <History internal={isRestaurant} orders={data.orders} catalog={data.catalog} reload={reload}
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
              <span>{fmtDate(o.delivery_date, t.lang)}{o.store ? <span className="muted"> · {o.store.name}</span> : ''}</span>
              <Status value={o.status} prefix="o" />
              <span className="num">{internal ? t('itemsN', { n: o.order_lines.length }) : `${fmtFt(total, t.lang)} ${t('netPrice')}`}</span>
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
