import { useState } from 'react'
import CrudPage from '../components/CrudPage'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtFt } from '../lib/i18n'
import { useAuth } from '../lib/auth'
import { NumInput, useToast, errText } from '../components/ui'

export default function Customers() {
  const t = useT()
  const { isAdmin } = useAuth()
  return (
    <CrudPage table="customers" title={t('nav_customers')} order="name"
      searchKeys={['name', 'contact_person', 'phone', 'address']}
      defaults={{ type: 'wholesale', active: true }}
      columns={[
        { key: 'name', label: t('name'), render: r => <b>{r.name}</b> },
        { key: 'type', label: t('ctype'), render: r => <span className={`tag tag-${r.type}`}>{t(r.type)}</span> },
        { key: 'contact_person', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'address', label: t('address') },
      ]}
      fields={[
        { key: 'name', label: t('name'), required: true },
        { key: 'type', label: t('ctype'), type: 'select', required: true, options: [['internal', t('internal')], ['wholesale', t('wholesale')]] },
        { key: 'contact_person', label: t('contact') },
        { key: 'phone', label: t('phone') },
        { key: 'email', label: t('email') },
        { key: 'vat_no', label: t('vatNo') },
        { key: 'address', label: t('address'), span: 2 },
        { key: 'delivery_notes', label: t('deliveryNotes'), type: 'textarea', span: 2 },
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
    const [products, prices] = await Promise.all([
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,base_price').eq('active', true).order('sort')),
      q(db.from('customer_prices').select('*').eq('customer_id', customerId)),
    ])
    return { products, prices: Object.fromEntries(prices.map(p => [p.product_id, p.price])) }
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
        <thead><tr><th>{t('name')}</th><th className="num">{t('basePrice')}</th><th className="num">{t('price')}</th></tr></thead>
        <tbody>
          {data.products.map(p => {
            const cur = p.id in edits ? edits[p.id] : data.prices[p.id]
            return (
              <tr key={p.id}>
                <td>{t.pick(p)} <span className="muted">/ {p.unit}</span></td>
                <td className="num muted">{fmtFt(p.base_price, t.lang)}</td>
                <td className="num">
                  <NumInput className="input-sm" value={cur} placeholder={String(p.base_price)}
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
