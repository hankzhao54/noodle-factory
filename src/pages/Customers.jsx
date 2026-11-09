import { useState } from 'react'
import CrudPage from '../components/CrudPage'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtFt } from '../lib/i18n'
import { useAuth } from '../lib/auth'
import { NumInput, useToast, errText } from '../components/ui'
import { dayName } from '../lib/orderRules'

export default function Customers() {
  const t = useT()
  const { isAdmin } = useAuth()
  const { data: tiers } = useData(() => q(db.from('price_tiers').select('id,name').order('sort').order('name')))
  const tierName = id => tiers?.find(x => x.id === id)?.name
  return (
    <CrudPage table="customers" title={t('nav_customers')} order="name" select="*,customer_locations(id,name,active)"
      searchKeys={['name', 'contact_person', 'phone', 'address']}
      defaults={{ type: 'wholesale', active: true }}
      columns={[
        { key: 'name', label: t('name'), render: r => <b>{r.name}</b> },
        { key: 'type', label: t('ctype'), render: r => <span className={`tag tag-${r.type}`}>{t(r.type)}</span> },
        { key: 'price_tier_id', label: t('priceTier'), render: r => tierName(r.price_tier_id) || <span className="muted">{t('basePrice')}</span> },
        { key: 'stores', label: t('stores'), render: r => {
          const st = (r.customer_locations || []).filter(l => l.active)
          return st.length ? <span title={st.map(l => l.name).join(', ')}>{t('storesN', { n: st.length })}</span> : <span className="muted">–</span> } },
        { key: 'contact_person', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'address', label: t('address') },
        { key: 'delivery_weekdays', label: t('deliveryDays'), render: r => r.delivery_weekdays?.length ? r.delivery_weekdays.map(d => dayName(t.lang, d)).join(', ') : <span className="muted">{t('anyDay')}</span> },
      ]}
      fields={[
        { key: 'name', label: t('name'), required: true },
        { key: 'type', label: t('ctype'), type: 'select', required: true, options: [['internal', t('internal')], ['wholesale', t('wholesale')]] },
        { key: 'contact_person', label: t('contact') },
        ...(isAdmin ? [{ key: 'price_tier_id', label: t('priceTier'), type: 'select', hint: t('priceTierHint'),
                         options: (tiers || []).map(x => [x.id, x.name]) }] : []),
        { key: 'phone', label: t('phone') },
        { key: 'email', label: t('email') },
        { key: 'vat_no', label: t('vatNo') },
        { key: 'address', label: t('address'), span: 2 },
        { key: 'delivery_notes', label: t('deliveryNotes'), type: 'textarea', span: 2 },
        { key: 'delivery_weekdays', label: t('deliveryDays'), type: 'weekdays', span: 2, hint: t('deliveryDaysHint') },
        { key: 'ramen_lead_place_id', label: t('ramenLead') },
        { key: 'active', label: t('active'), type: 'bool' },
      ]}
      extraFormContent={row => <>
        <LocationsEditor customerId={row.id} />
        {isAdmin && <PriceEditor customerId={row.id} />}
      </>} />
  )
}

function PriceEditor({ customerId }) {
  const t = useT()
  const toast = useToast()
  const { data } = useData(async () => {
    const [products, prices, effective] = await Promise.all([
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,base_price').eq('active', true).order('sort')),
      q(db.from('customer_prices').select('*').eq('customer_id', customerId)),
      q(db.rpc('prices_for_customer', { p_customer: customerId })),
    ])
    // price without the customer's own price: tier price if set, else base
    const tierPrice = {}
    effective.forEach(e => { if (e.source === 'tier') tierPrice[e.product_id] = e.price })
    return { products, prices: Object.fromEntries(prices.map(p => [p.product_id, p.price])), tierPrice }
  }, [customerId])
  const [edits, setEdits] = useState({})
  if (!data) return null

  async function saveOne(pid) {
    const val = edits[pid]
    try {
      if (val === null || val === undefined) await q(db.from('customer_prices').delete().match({ customer_id: customerId, product_id: pid }))
      else await q(db.from('customer_prices').upsert({ customer_id: customerId, product_id: pid, price: val }))
      toast(t('saved'))
    } catch (e) { toast(errText(e), 'error') }
  }

  return (
    <section className="subsection">
      <h3>{t('prices')}</h3>
      <p className="muted small">{t('pricesHint')}</p>
      <table className="table compact">
        <thead><tr><th>{t('name')}</th><th className="num">{t('basePrice')}</th><th className="num">{t('tierPrice')}</th><th className="num">{t('ownPrice')}</th></tr></thead>
        <tbody>
          {data.products.map(p => {
            const cur = p.id in edits ? edits[p.id] : data.prices[p.id]
            const fallback = data.tierPrice[p.id] ?? p.base_price
            return (
              <tr key={p.id}>
                <td>{t.pick(p)} <span className="muted">/ {p.unit}</span></td>
                <td className="num muted">{fmtFt(p.base_price, t.lang)}</td>
                <td className="num muted">{data.tierPrice[p.id] != null ? fmtFt(data.tierPrice[p.id], t.lang) : '–'}</td>
                <td className="num">
                  <NumInput className="input-sm" value={cur} placeholder={String(Number(fallback))}
                    onChange={x => setEdits(s => ({ ...s, [p.id]: x }))} onBlur={() => p.id in edits && saveOne(p.id)} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

// Stores of a company: each with its own delivery address, contact and delivery days.
// Prices stay on the company. A company with stores must pick a store when ordering.
function LocationsEditor({ customerId }) {
  const t = useT()
  const toast = useToast()
  const [editing, setEditing] = useState(null)   // location row or {} for new
  const [showOld, setShowOld] = useState(false)
  const { data, reload } = useData(() => q(db.from('customer_locations').select('*').eq('customer_id', customerId)
    .order('sort').order('name')), [customerId])
  if (!data) return null
  const list = data.filter(l => showOld || l.active)
  const inactive = data.filter(l => !l.active).length

  async function save(v) {
    const row = { name: v.name.trim(), address: v.address || null, contact_person: v.contact_person || null, phone: v.phone || null,
      notes: v.notes || null, active: v.active !== false,
      delivery_weekdays: v.delivery_weekdays?.length ? [...v.delivery_weekdays].sort() : null }
    try {
      if (v.id) await q(db.from('customer_locations').update(row).eq('id', v.id))
      else await q(db.from('customer_locations').insert({ ...row, customer_id: customerId, sort: data.length }))
      toast(t('saved')); setEditing(null); reload()
    } catch (e) { toast(errText(e), 'error') }
  }

  return (
    <section className="subsection">
      <div className="row-gap" style={{ justifyContent: 'space-between' }}>
        <h3>{t('stores')}</h3>
        {!editing && <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing({ active: true })}>{t('addStore')}</button>}
      </div>
      <p className="muted small">{t('storesHint')}</p>
      {list.length > 0 && <table className="table compact">
        <thead><tr><th>{t('name')}</th><th>{t('address')}</th><th>{t('deliveryDays')}</th><th></th></tr></thead>
        <tbody>{list.map(l => (
          <tr key={l.id} className={l.active ? '' : 'muted'}>
            <td><b>{l.name}</b>{!l.active && <> · {t('inactive')}</>}{l.contact_person && <div className="muted small">{l.contact_person}{l.phone ? ` · ${l.phone}` : ''}</div>}</td>
            <td className="small">{l.address || '–'}</td>
            <td className="small">{l.delivery_weekdays?.length ? l.delivery_weekdays.map(d => dayName(t.lang, d)).join(', ') : <span className="muted">{t('sameAsCompany')}</span>}</td>
            <td className="num"><button type="button" className="btn-link" onClick={() => setEditing(l)}>{t('edit')}</button></td>
          </tr>
        ))}</tbody>
      </table>}
      {inactive > 0 && <button type="button" className="btn-link small" onClick={() => setShowOld(x => !x)}>{showOld ? t('hideInactive') : t('showInactiveN', { n: inactive })}</button>}
      {editing && <StoreForm value={editing} onCancel={() => setEditing(null)} onSave={save} />}
    </section>
  )
}

function StoreForm({ value, onCancel, onSave }) {
  const t = useT()
  const [v, setV] = useState({ ...value })
  const set = (k, x) => setV(s => ({ ...s, [k]: x }))
  const days = v.delivery_weekdays || []
  return (
    <div className="store-form">
      <div className="form-grid">
        <label className="field"><span className="field-label">{t('storeName')} *</span>
          <input value={v.name || ''} onChange={e => set('name', e.target.value)} placeholder={t('storeNamePh')} /></label>
        <label className="field"><span className="field-label">{t('contact')}</span>
          <input value={v.contact_person || ''} onChange={e => set('contact_person', e.target.value)} /></label>
        <label className="field span-2"><span className="field-label">{t('address')}</span>
          <input value={v.address || ''} onChange={e => set('address', e.target.value)} /></label>
        <label className="field"><span className="field-label">{t('phone')}</span>
          <input value={v.phone || ''} onChange={e => set('phone', e.target.value)} /></label>
        <label className="field"><span className="field-label">{t('deliveryNotes')}</span>
          <input value={v.notes || ''} onChange={e => set('notes', e.target.value)} /></label>
        <div className="field span-2"><span className="field-label">{t('deliveryDays')}</span>
          <div className="row-gap wrap">{[1, 2, 3, 4, 5, 6, 7].map(d => (
            <label key={d} className="check-inline"><input type="checkbox" checked={days.includes(d)}
              onChange={e => set('delivery_weekdays', e.target.checked ? [...days, d] : days.filter(x => x !== d))} />{dayName(t.lang, d)}</label>))}</div>
          <span className="field-hint">{t('storeDaysHint')}</span></div>
        {v.id && <label className="check-inline"><input type="checkbox" checked={v.active !== false} onChange={e => set('active', e.target.checked)} />{t('active')}</label>}
      </div>
      <div className="row-gap" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!v.name?.trim()} onClick={() => onSave(v)}>{t('saveStore')}</button>
      </div>
    </div>
  )
}
