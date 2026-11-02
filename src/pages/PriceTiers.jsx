import { useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtFt } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty, BlurNum, Modal, useToast, errText } from '../components/ui'

// Price tiers: one column per tier, one row per product. Empty cell = the product's base price.
// A customer's own price (Customers page) still beats the tier price.
export default function PriceTiers() {
  const t = useT()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState(null)   // tier being renamed / deleted
  const { data, error, reload } = useData(async () => {
    const [tiers, prices, products, customers] = await Promise.all([
      q(db.from('price_tiers').select('*').order('sort').order('name')),
      q(db.from('price_tier_prices').select('*')),
      q(db.from('products').select('id,code,name_zh,name_en,name_hu,unit,base_price,sort,active').eq('active', true).order('sort')),
      q(db.from('customers').select('id,name,price_tier_id').eq('active', true)),
    ])
    return { tiers, prices, products, customers }
  })
  const run = async (p, msg = t('saved')) => {
    try { await q(p); toast(msg); await reload(); return true } catch (e) { toast(errText(e), 'error'); return false }
  }
  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data) return <div className="page"><Loading /></div>

  const priceOf = (tier, product) => data.prices.find(x => x.tier_id === tier && x.product_id === product)?.price ?? null
  const setPrice = (tier, product, v) => run(v == null
    ? db.from('price_tier_prices').delete().match({ tier_id: tier, product_id: product })
    : db.from('price_tier_prices').upsert({ tier_id: tier, product_id: product, price: v }))
  const customersOf = tier => data.customers.filter(c => c.price_tier_id === tier)

  async function addTier(e) {
    e.preventDefault()
    const name = adding.trim(); if (!name) return
    if (await run(db.from('price_tiers').insert({ name, sort: data.tiers.length }))) setAdding('')
  }

  return (
    <div className="page">
      <PageHead title={t('nav_priceTiers')}>
        {isAdmin && <form className="row-gap nowrap" onSubmit={addTier}>
          <input value={adding} onChange={e => setAdding(e.target.value)} placeholder={t('tierNamePh')} aria-label={t('tierName')} />
          <button className="btn btn-primary" disabled={!adding.trim()}>{t('addTier')}</button>
        </form>}
      </PageHead>
      <p className="muted lead">{t('tiersIntro')}</p>
      {!isAdmin && <p className="muted small">{t('lsAdminOnly')}</p>}

      {data.tiers.length === 0 ? <Empty>{t('noTiers')}</Empty> : (
        <div className="table-wrap"><table className="table tier-table">
          <thead><tr>
            <th>{t('name')}</th>
            <th className="num">{t('basePrice')}</th>
            {data.tiers.map(tr => (
              <th key={tr.id} className="num">
                {isAdmin ? <button type="button" className="btn-link tier-head" onClick={() => setEditing(tr)}>{tr.name}</button> : tr.name}
                <div className="muted small tier-count">{t('customersN', { n: customersOf(tr.id).length })}</div>
              </th>
            ))}
          </tr></thead>
          <tbody>{data.products.map(p => (
            <tr key={p.id}>
              <td><b>{t.pick(p)}</b> <span className="muted">/ {p.unit}</span></td>
              <td className="num muted">{fmtFt(p.base_price, t.lang)}</td>
              {data.tiers.map(tr => {
                const v = priceOf(tr.id, p.id)
                return (
                  <td key={tr.id} className="num">
                    <BlurNum className="input-sm" value={v} min={0} disabled={!isAdmin} placeholder={String(Number(p.base_price))}
                      aria-label={`${tr.name} · ${t.pick(p)}`} onCommit={x => setPrice(tr.id, p.id, x)} />
                  </td>
                )
              })}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>{t('tiersHint')}</p>

      {editing && <TierDialog tier={editing} customers={customersOf(editing.id)} onClose={() => setEditing(null)}
        onRename={async name => { if (await run(db.from('price_tiers').update({ name }).eq('id', editing.id))) setEditing(null) }}
        onDelete={async () => { if (await run(db.from('price_tiers').delete().eq('id', editing.id), t('deleted'))) setEditing(null) }} />}
    </div>
  )
}

function TierDialog({ tier, customers, onClose, onRename, onDelete }) {
  const t = useT()
  const [name, setName] = useState(tier.name)
  const [confirm, setConfirm] = useState(false)
  return (
    <Modal title={`${t('priceTier')} · ${tier.name}`} onClose={onClose}>
      <form className="stack" onSubmit={e => { e.preventDefault(); if (name.trim()) onRename(name.trim()) }}>
        <label className="field"><span className="field-label">{t('tierName')}</span>
          <input value={name} onChange={e => setName(e.target.value)} required /></label>
        <p className="muted small">{customers.length ? `${t('customersInTier')}: ${customers.map(c => c.name).join(', ')}` : t('noCustomersInTier')}</p>
        {confirm && <p className="note-box">{t('deleteTierWarn', { n: customers.length })}</p>}
        <div className="modal-foot">
          {confirm
            ? <button type="button" className="btn btn-danger" onClick={onDelete}>{t('deleteTierConfirm')}</button>
            : <button type="button" className="btn btn-danger-quiet" onClick={() => setConfirm(true)}>{t('delete')}</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || name.trim() === tier.name}>{t('save')}</button>
        </div>
      </form>
    </Modal>
  )
}
