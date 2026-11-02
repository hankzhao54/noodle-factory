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
    <CrudPage table="customers" title={t('nav_customers')} order="name"
      searchKeys={['name', 'contact_person', 'phone', 'address']}
      defaults={{ type: 'wholesale', active: true }}
      columns={[
        { key: 'name', label: t('name'), render: r => <b>{r.name}</b> },
        { key: 'type', label: t('ctype'), render: r => <span className={`tag tag-${r.type}`}>{t(r.type)}</span> },
        { key: 'price_tier_id', label: t('priceTier'), render: r => tierName(r.price_tier_id) || <span className="muted">{t('basePrice')}</span> },
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
      extraFormContent={row => isAdmin ? <PriceEditor customerId={row.id} /> : null} />
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
