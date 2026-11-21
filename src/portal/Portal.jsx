import { useState } from 'react'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtFt, fmtNum, fmtDate } from '../lib/i18n'
import { LangSwitch } from '../App'
import { Loading, ErrorBox, Empty, Status, Tabs, NumInput, Modal, Field, useToast, errText } from '../components/ui'
import QtyPicker, { cartTotal, packOk } from '../components/QtyPicker'
import { packFees, packText, lineFee, hasPacking } from '../lib/packing'
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
  const [pack, setPack] = useState({})   // product id → { vacuum, portion_g }; missing = the customer's default
  const { data, error, reload } = useData(async () => {
    const [me, catalog, orders, rules, pinfo, editInfo, requests] = await Promise.all([
      q(db.from('customers').select('*').maybeSingle()),
      q(db.from('my_catalog').select('*').order('sort')),
      q(db.from('orders').select('id, no, status, delivery_date, notes, created_at, delivered_at, received_by, urgent, store:customer_locations(name), order_lines(id, product_id, qty, pack_vacuum, portion_g' + (isRestaurant ? '' : ', unit_price, vacuum_fee, portion_fee') + ')').order('created_at', { ascending: false }).limit(50)),
      q(db.rpc('order_rules')).catch(() => null),
      q(db.rpc('product_info')).catch(() => null),
      q(db.rpc('my_order_edit_info')).catch(() => ({})),
      q(db.from('order_change_requests').select('*').order('created_at', { ascending: false }).limit(100)).catch(() => []),
    ])
    return { me, catalog, orders, rules, pinfo, editInfo: editInfo || {}, requests: requests || [] }
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
      <Tabs value={tab} onChange={setTab} tabs={[['order', t('portalOrder')], ['history', t('portalHistory')],
        ...(profile?.role === 'customer' && data?.me ? [['company', t('portalCompany')]] : [])]} />
      <ErrorBox error={error} />
      {!data ? <Loading /> : !profile?.customer_id || !data.me ? (
        <p className="note-box">{t('noCustomerLink')}</p>
      ) : tab === 'company' ? (
        <CompanyDetails me={data.me} storeOnly={!!data.rules?.my_location} reload={reload} />
      ) : tab === 'order' ? (
        <OrderSheet blocked={needTerms} info={info} pinfo={data.pinfo} internal={isRestaurant} catalog={data.catalog} me={data.me} rules={data.rules} qty={qty} setQty={setQty}
          pack={pack} setPack={setPack} onPlaced={() => { setQty({}); setPack({}); reload(); setTab('history') }} />
      ) : (
        <History internal={isRestaurant} fees={packFees(info)} orders={data.orders} catalog={data.catalog} editInfo={data.editInfo} requests={data.requests} reload={reload}
          onAgain={o => {
            const next = {}, nextPack = {}
            o.order_lines.forEach(l => { if (data.catalog.some(p => p.id === l.product_id)) {
              next[l.product_id] = Number(l.qty); nextPack[l.product_id] = { vacuum: !!l.pack_vacuum, portion_g: l.portion_g ?? null } } })
            setQty(next); setPack(nextPack); setTab('order')
          }} />
      )}
      <LegalLinks className="portal-legal" />
    </div>
  )
}

/* ---------------- external customers keep their own company (billing) and store details ---------------- */
function CompanyDetails({ me, storeOnly, reload }) {
  const t = useT()
  const toast = useToast()
  const stores = useData(() => q(db.from('customer_locations').select('id,name,address,contact_person,phone,notes,active').eq('active', true).order('sort')), [])
  const [f, setF] = useState(() => ({ name: me.name || '', address: me.address || '', vat_no: me.vat_no || '', contact: me.contact_person || '',
    phone: me.phone || '', email: me.email || '', notes: me.delivery_notes || '' }))
  const [busy, setBusy] = useState(false)
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  async function save(e) {
    e.preventDefault(); setBusy(true)
    try {
      await q(db.rpc('update_my_company', { p_name: f.name, p_address: f.address, p_vat_no: f.vat_no, p_contact: f.contact,
        p_phone: f.phone, p_email: f.email, p_notes: f.notes }))
      toast(t('saved')); reload()
    } catch (err) { toast(errText(err), 'error') }
    setBusy(false)
  }
  return (
    <div className="stack">
      {storeOnly ? <p className="muted small">{t('companyStoreOnly')}</p> : (
        <form className="panel stack" onSubmit={save}>
          <h3>{t('companyDetails')}</h3>
          <p className="muted small">{t('companyHint')}</p>
          <Field label={t('companyName')}><input required value={f.name} onChange={set('name')} /></Field>
          <Field label={t('billingAddress')}><textarea rows={2} value={f.address} onChange={set('address')} /></Field>
          <Field label={t('vatNo')} hint={t('vatNoHint')}><input value={f.vat_no} onChange={set('vat_no')} placeholder="12345678-2-42" /></Field>
          <div className="form-grid">
            <Field label={t('contactPerson')}><input value={f.contact} onChange={set('contact')} /></Field>
            <Field label={t('phone')}><input type="tel" value={f.phone} onChange={set('phone')} /></Field>
          </div>
          <Field label={t('billingEmail')}><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label={t('deliveryNotes')}><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
          <div className="modal-foot"><span className="grow" /><button className="btn btn-primary" disabled={busy}>{t('save')}</button></div>
        </form>
      )}
      {(stores.data || []).map(st => <StoreDetails key={st.id} store={st} onSaved={() => { stores.reload(); reload() }} />)}
    </div>
  )
}

function StoreDetails({ store, onSaved }) {
  const t = useT()
  const toast = useToast()
  const [f, setF] = useState({ address: store.address || '', contact: store.contact_person || '', phone: store.phone || '', notes: store.notes || '' })
  const [busy, setBusy] = useState(false)
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  async function save(e) {
    e.preventDefault(); setBusy(true)
    try { await q(db.rpc('update_my_store', { p_store: store.id, p_address: f.address, p_contact: f.contact, p_phone: f.phone, p_notes: f.notes })); toast(t('saved')); onSaved() }
    catch (err) { toast(errText(err), 'error') }
    setBusy(false)
  }
  return (
    <form className="panel stack" onSubmit={save}>
      <h3>🏪 {store.name}</h3>
      <Field label={t('deliveryAddress')}><textarea rows={2} value={f.address} onChange={set('address')} /></Field>
      <div className="form-grid">
        <Field label={t('contactPerson')}><input value={f.contact} onChange={set('contact')} /></Field>
        <Field label={t('phone')}><input type="tel" value={f.phone} onChange={set('phone')} /></Field>
      </div>
      <Field label={t('deliveryNotes')}><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
      <div className="modal-foot"><span className="grow" /><button className="btn btn-primary" disabled={busy}>{t('save')}</button></div>
    </form>
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
function OrderSheet({ blocked, info, pinfo, internal, catalog, me, rules: baseRules, qty, setQty, pack, setPack, onPlaced }) {
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
  // urgent order: any day from today, closed days included — the factory confirms it
  const [urgent, setUrgent] = useState(false)
  const urgentRules = rules && { ...rules, earliest: todayISO(), weekdays: '', my_weekdays: [], closed_dates: '' }
  const options = nextDates(urgent ? urgentRules : rules, 6)
  const [date, setDate] = useState(() => nextDates(rules, 1)[0] || todayISO(1))
  function pickStore(id) {
    setStoreId(id); try { localStorage.setItem(STORE_KEY, id) } catch { /* ignore */ }
    const l = stores.find(x => x.id === id)
    const r = baseRules && l?.weekdays?.length ? { ...baseRules, my_weekdays: l.weekdays } : baseRules
    if (dateProblem(r, date)) setDate(nextDates(r, 1)[0] || date)
  }
  const needStore = stores.length > 0 && !store
  const rawProblem = dateProblem(rules, date)
  const problem = urgent ? (date < todayISO() ? 'too_late' : dateProblem(urgentRules, date)) : rawProblem
  function toggleUrgent() {
    const on = !urgent
    setUrgent(on)
    if (on) setDate(nextDates(urgentRules, 1)[0] || todayISO())
    else if (dateProblem(rules, date)) setDate(nextDates(rules, 1)[0] || date)
  }
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const fees = packFees(info)
  const packDef = { vacuum: !!me.pack_vacuum, portion_g: me.portion_g ?? null }
  const packOf = id => pack[id] || packDef
  const total = cartTotal(catalog, qty, pack, packDef, internal ? null : fees)
  const count = Object.keys(qty).length
  const packBad = Object.keys(qty).some(id => !packOk(packOf(id)))

  async function place() {
    setBusy(true)
    try {
      await q(db.rpc('place_order', {
        p_delivery_date: date, p_notes: notes || null, p_location_id: storeId || null, p_urgent: urgent,
        p_lines: Object.entries(qty).map(([product_id, q]) => ({ product_id, qty: q, pack_vacuum: !!packOf(product_id).vacuum, portion_g: packOf(product_id).portion_g || null })),
      }))
      toast(t(urgent ? 'urgentPlaced' : internal ? 'orderPlacedInternal' : 'orderPlaced')); setNotes(''); setUrgent(false); onPlaced()
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
          <input type="date" min={urgent ? todayISO() : rules?.earliest || todayISO()} value={date} onChange={e => setDate(e.target.value)} /></label>
        {rules?.urgent && (
          <button type="button" className={urgent ? 'chip chip-urgent on' : 'chip chip-urgent'} aria-pressed={urgent} onClick={toggleUrgent}>
            🚨 {t('urgentOrder')}
          </button>
        )}
        {urgent && <p className="urgent-note small">{t('urgentNote')}</p>}
        {problem && <p className="error-box small">{t('dp_' + problem)}{rules?.urgent && !urgent && ['no_delivery_day', 'not_your_day'].includes(problem) ? ' ' + t('urgentHint') : ''}</p>}
        {rules && <p className="muted small">{t('rulesNote', { cutoff: rules.cutoff || '–', days })}</p>}
        {(store ? store.address : me.address) && <p className="muted small">{store ? `${store.name} · ${store.address}` : me.address}</p>}
      </div>
      {catalog.length === 0 ? <Empty /> : <QtyPicker items={catalog} qty={qty} setQty={setQty} info={pinfo}
        pack={pack} setPack={setPack} packInfo={{ def: packDef, fees, internal }}
        producer={info ? [info.company_name, info.company_address].filter(Boolean).join(', ') : null} />}
      <label className="field"><span className="field-label">{t('notes')}</span>
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="cart-bar">
        <div>
          <b>{internal ? t('itemsN', { n: count }) : `${fmtFt(total, t.lang)} ${t('netPrice')}`}</b>
          <span className="muted small">{internal ? (count ? t('internalOrderNote') : t('emptyCart')) : <>{count ? t('itemsN', { n: count }) : t('emptyCart')} · {t('noPayment')}</>}</span>
        </div>
        <button className="btn btn-primary" disabled={!count || busy || !!problem || blocked || needStore || packBad} onClick={place}>{urgent ? '🚨 ' + t('placeUrgent') : t('placeOrder')}</button>
      </div>
    </div>
  )
}

function History({ internal, fees, orders, catalog, editInfo, requests = [], reload, onAgain }) {
  const t = useT()
  const toast = useToast()
  const [openId, setOpenId] = useState(null)
  const [ask, setAsk] = useState(null)        // 'order:<id>' waiting for the second tap
  const [editing, setEditing] = useState(null) // order id being changed
  const [draft, setDraft] = useState({})       // line id → qty (0 = cancel)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(null)   // order for which a change request is being written
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
        const total = o.order_lines.reduce((s, l) => s + l.qty * ((l.unit_price || 0) + lineFee(l, fees)), 0)
        const open = openId === o.id
        const info = editInfo?.[o.id]                       // present = this account may still change it
        const locked = new Set(info?.locked || [])
        const isEditing = editing === o.id
        const q0 = l => (l.id in draft ? draft[l.id] : Number(l.qty))
        const reqs = requests.filter(r => r.order_id === o.id)
        const pending = reqs.find(r => r.status === 'pending')
        const lastDecided = reqs.find(r => r.status === 'approved' || r.status === 'rejected')
        // can't change it directly any more (or some products are locked): ask the factory
        const canRequest = (!info || locked.size > 0) && ['submitted', 'confirmed', 'ready'].includes(o.status)
        return (
          <li key={o.id} className={open ? 'open' : ''}>
            <button className="history-row" aria-expanded={open} onClick={() => { setOpenId(open ? null : o.id); setEditing(null); setDraft({}) }}>
              <span className="mono-num">#{o.no}</span>
              <span>{o.urgent && <span className="tag tag-urgent">🚨 {t('urgent')}</span>} {fmtDate(o.delivery_date, t.lang)}{o.store ? <span className="muted"> · {o.store.name}</span> : ''}</span>
              <Status value={o.status} prefix="o" />
              <span className="num">{internal ? t('itemsN', { n: o.order_lines.length }) : `${fmtFt(total, t.lang)} ${t('netPrice')}`}</span>
            </button>
            {open && (
              <div className="history-body">
                <ul>{o.order_lines.map(l => {
                  const gone = isEditing && !(Number(q0(l)) > 0)
                  return (
                  <li key={l.id} className={gone ? 'line-gone' : ''}><span>{t.pick(prod(l.product_id)) || '–'}
                    {hasPacking(l) && <span className="pack-tag">📦 {packText(t, l, fees.bag)}{!internal && lineFee(l, fees) > 0 ? ` · +${fmtFt(lineFee(l, fees), t.lang)}/kg` : ''}</span>}</span>
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
                    {canRequest && !pending && <button className="btn btn-sm" onClick={() => setAsking(o)}>✋ {t('requestChange')}</button>}
                    {info && !locked.size && (ask === 'order:' + o.id
                      ? <button className="btn btn-sm btn-danger" onClick={() => cancel(o)}>{t('cancelOrderConfirm')}</button>
                      : <button className="btn btn-sm btn-danger-quiet" onClick={() => setAsk('order:' + o.id)}>{t('cancelOrder')}</button>)}
                  </>}
                </div>
                {pending && <RequestInfo r={pending} prod={prod} lines={o.order_lines} reload={reload} />}
                {!pending && lastDecided && <p className={`small ${lastDecided.status === 'approved' ? 'ok-text' : 'error-text'}`}>
                  {t(lastDecided.status === 'approved' ? 'changeApproved' : 'changeRejected')}{lastDecided.decision_note ? `: ${lastDecided.decision_note}` : ''}</p>}
                {o.status === 'delivered' && o.delivered_at && <p className="muted small">✓ {t('receivedOn')} {fmtDateTime(o.delivered_at, t.lang)}{o.received_by ? ` · ${o.received_by}` : ''}</p>}
                
              </div>
            )}
          </li>
        )
      })}
      {asking && <ChangeRequest order={asking} catalog={catalog} onClose={() => setAsking(null)} onDone={() => { setAsking(null); reload() }} />}
    </ul>
  )
}

// a change request waiting for the factory, with "withdraw"
function RequestInfo({ r, prod, lines, reload }) {
  const t = useT()
  const toast = useToast()
  const lineOf = id => lines.find(l => l.id === id) || {}
  async function withdraw() {
    try { await q(db.rpc('withdraw_change_request', { p_request: r.id })); toast(t('requestWithdrawn')); reload() }
    catch (e) { toast(errText(e), 'error') }
  }
  return (
    <div className="note-box small change-pending">
      <b>⏳ {t('changePending')}</b>
      <ul>
        {r.lines.map(c => { const l = lineOf(c.line_id); if (!l.id) return null; const p = prod(l.product_id) || {}
          return <li key={c.line_id}>{t.pick(p)}: {fmtNum(l.qty, t.lang)} → {Number(c.qty) > 0 ? `${fmtNum(c.qty, t.lang)} ${p.unit || ''}` : '✕'}</li> })}
        {r.additions.map(a => { const p = prod(a.product_id) || {}
          return <li key={a.product_id}>+ {t.pick(p)} {fmtNum(a.qty, t.lang)} {p.unit || ''}</li> })}
        {r.delivery_date && <li>📅 {fmtDate(r.delivery_date, t.lang)}</li>}
        {r.note && <li>“{r.note}”</li>}
      </ul>
      <button className="btn-link small" onClick={withdraw}>{t('withdrawRequest')}</button>
    </div>
  )
}

// ask the factory to change a confirmed order: new quantities, extra products, another day, a note
function ChangeRequest({ order: o, catalog, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [qty, setQty] = useState(() => Object.fromEntries(o.order_lines.map(l => [l.id, Number(l.qty)])))
  const [adds, setAdds] = useState([])          // [{ product_id, qty }]
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const prod = id => catalog.find(p => p.id === id) || {}
  const inOrder = new Set(o.order_lines.map(l => l.product_id))
  const addable = catalog.filter(p => !inOrder.has(p.id) && !adds.some(a => a.product_id === p.id))
  async function send() {
    setBusy(true)
    try {
      await q(db.rpc('request_order_change', {
        p_order: o.id,
        p_lines: o.order_lines.map(l => ({ line_id: l.id, qty: Number(qty[l.id] || 0) })),
        p_additions: adds.filter(a => Number(a.qty) > 0),
        p_date: date || null, p_note: note || null }))
      toast(t('requestSent')); onDone()
    } catch (e) { toast(/nothing to change/.test(e.message || '') ? t('nothingChanged') : errText(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={`✋ ${t('requestChange')} · #${o.no}`} onClose={onClose}>
      <p className="muted small">{t('requestChangeHint')}</p>
      <div className="table-wrap"><table className="table compact"><tbody>
        {o.order_lines.map(l => { const p = prod(l.product_id); return (
          <tr key={l.id}><td>{t.pick(p) || '–'}</td>
            <td className="num"><NumInput className="input-sm" value={qty[l.id]} min={0} onChange={v => setQty(x => ({ ...x, [l.id]: v ?? 0 }))} /> {p.unit}</td></tr>) })}
        {adds.map((a, i) => { const p = prod(a.product_id); return (
          <tr key={a.product_id}><td>+ {t.pick(p)}</td>
            <td className="num"><NumInput className="input-sm" value={a.qty} min={0} onChange={v => setAdds(x => x.map((y, j) => j === i ? { ...y, qty: v ?? 0 } : y))} /> {p.unit}</td></tr>) })}
      </tbody></table></div>
      {addable.length > 0 && (
        <select value="" onChange={e => e.target.value && setAdds(x => [...x, { product_id: e.target.value, qty: 0 }])}>
          <option value="">+ {t('addProduct')}</option>
          {addable.map(p => <option key={p.id} value={p.id}>{t.pick(p)}</option>)}
        </select>)}
      <Field label={t('newDeliveryDateOptional')}><input type="date" value={date} min={todayISO()} onChange={e => setDate(e.target.value)} /></Field>
      <Field label={t('notes')}><textarea rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <div className="modal-foot"><span className="grow" />
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={send}>{t('sendRequest')}</button>
      </div>
    </Modal>
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
