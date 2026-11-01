import { Link } from 'react-router-dom'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { useAuth } from '../lib/auth'
import { Loading, ErrorBox } from '../components/ui'
import InstallHint from '../components/InstallHint'
import { buildPlan, materialNeeds } from '../lib/plan'
import { daysUntil } from '../lib/lots'
import { ExpiryTag } from './Inventory'

export default function Dashboard() {
  const t = useT()
  const { profile, isAdmin } = useAuth()
  const tomorrow = todayISO(1)
  const { data, error } = useData(async () => {
    const [newOrders, tomorrowOrders, runs, low, batches, pos, pending,
           products, recipe, mstock, pstock, demand, lots, suppliers, warn] = await Promise.all([
      q(db.from('orders').select('id').eq('status', 'submitted')),
      q(db.from('orders').select('id').eq('delivery_date', tomorrow).neq('status', 'cancelled')),
      q(db.from('deliveries').select('id,status').eq('delivery_date', todayISO())),
      q(db.from('material_stock').select('*').eq('below_min', true)),
      q(db.from('production_batches').select('id,product_id,batches,status').eq('status', 'planned')),
      q(db.from('purchase_orders').select('id').eq('status', 'ordered')),
      isAdmin ? q(db.rpc('list_users')).then(u => u.filter(x => x.role === 'pending')) : Promise.resolve([]),
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,batch_yield,sort').eq('active', true).order('sort')),
      q(db.from('recipe_lines').select('product_id,material_id,qty_per_batch')),
      q(db.from('material_stock').select('id,name_zh,name_en,name_hu,unit,on_hand')),
      q(db.from('product_stock').select('id,on_hand')),
      q(db.from('production_demand').select('*').lte('delivery_date', tomorrow)),
      q(db.from('material_lots').select('*').not('expiry_date', 'is', null).order('expiry_date')),
      q(db.from('suppliers').select('id,name')),
      q(db.from('settings').select('value').eq('key', 'lot_expiry_warn_days').maybeSingle()),
    ])
    return { newOrders, tomorrowOrders, runs, low, batches, pos, pending, products, recipe, mstock, pstock, demand, lots, suppliers,
             warnDays: Number(warn?.value) || 14 }
  }, [isAdmin, tomorrow])

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data) return <div className="page"><Loading /></div>

  const openRuns = data.runs.filter(r => r.status !== 'done').length
  const expiring = data.lots.filter(l => daysUntil(l.expiry_date) <= data.warnDays)
  const rows = [
    { n: data.newOrders.length, label: t('newOrders'), to: '/orders', urgent: true },
    { n: data.pending.length, label: t('pendingAccounts'), to: '/users', urgent: true },
    { n: openRuns, label: t('todayDeliveries'), to: '/deliveries' },
    { n: data.tomorrowOrders.length, label: t('tomorrowOrders'), to: '/orders' },
    { n: data.batches.length, label: t('openBatches'), to: '/production' },
    { n: data.pos.length, label: t('openPOs'), to: '/purchasing' },
  ]
  const todo = rows.filter(r => r.n > 0)

  // tomorrow's plan: what still has to be made + materials for open and suggested batches
  const plan = buildPlan({ ...data, batches: data.batches })
  const toDo = plan.filter(r => r.suggest > 0)
  const byProduct = {}
  data.batches.forEach(b => { byProduct[b.product_id] = (byProduct[b.product_id] || 0) + Number(b.batches) })
  toDo.forEach(r => { byProduct[r.p.id] = (byProduct[r.p.id] || 0) + r.suggest })
  const short = materialNeeds(byProduct, data.recipe, data.mstock).filter(x => x.short > 0)

  const supName = id => data.suppliers.find(s => s.id === id)?.name || t('noSupplier')
  const lowBySup = {}
  data.low.forEach(m => { (lowBySup[m.default_supplier_id || ''] ||= []).push(m) })
  const allClear = todo.length === 0 && plan.length === 0 && data.low.length === 0 && expiring.length === 0

  return (
    <div className="page">
      <div className="hello">
        <h1>{fmtDate(new Date(), t.lang)}</h1>
        <p className="muted">{profile?.display_name}</p>
      </div>
      <InstallHint />
      {allClear && <p className="all-good">{t('allGood')}</p>}
      {todo.length > 0 && (
        <ul className="todo-list">
          {todo.map(r => (
            <li key={r.label} className={r.urgent ? 'urgent' : ''}>
              <Link to={r.to}>
                <span className="todo-n">{r.n}</span>
                <span className="todo-label">{r.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {plan.length > 0 && (
        <section className="panel dash-panel">
          <div className="panel-head">
            <h2>{t('planTomorrow', { date: fmtDate(tomorrow, t.lang) })}</h2>
            <Link className="btn btn-sm" to="/production">{t('nav_production')} →</Link>
          </div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('name')}</th><th className="num">{t('demand')}</th><th className="num">{t('onHand')}</th>
              <th className="num">{t('b_planned')}</th><th className="num">{t('toMake')}</th><th className="num">{t('batches')}</th></tr></thead>
            <tbody>{plan.map(r => (
              <tr key={r.p.id} className={r.toMake > 0 ? 'row-todo' : ''}>
                <td><b>{t.pick(r.p)}</b></td>
                <td className="num">{fmtNum(r.demand, t.lang)} <span className="unit">{r.p.unit}</span></td>
                <td className="num muted">{fmtNum(r.onHand, t.lang)}</td>
                <td className="num muted">{fmtNum(r.planned, t.lang)}</td>
                <td className="num"><b>{r.toMake > 0 ? fmtNum(r.toMake, t.lang) : '✓'}</b></td>
                <td className="num">{r.suggest || '–'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {short.length > 0 ? (
            <div className="dash-warn">
              <b>{t('shortForPlan')}</b>
              <ul>{short.map(({ m, qty, short: s }) => (
                <li key={m.id}>{t.pick(m)}: {t('needHave', { need: fmtNum(qty, t.lang), have: fmtNum(m.on_hand, t.lang), unit: m.unit || '' })}
                  <span className="tag tag-low">{t('short')} {fmtNum(s, t.lang)} {m.unit}</span></li>
              ))}</ul>
            </div>
          ) : toDo.length > 0 && <p className="dash-ok">{t('enoughForPlan')}</p>}
        </section>
      )}

      {data.low.length > 0 && (
        <section className="panel dash-panel">
          <div className="panel-head">
            <h2>{t('lowStock')} ({data.low.length})</h2>
            <Link className="btn btn-sm" to="/purchasing">{t('addToPO')} →</Link>
          </div>
          <ul className="dash-list">
            {Object.entries(lowBySup).map(([sid, items]) => (
              <li key={sid}>
                <span className="dash-sup">{supName(sid || null)}</span>
                {items.map(m => (
                  <span key={m.id} className="dash-item">
                    {t.pick(m)} <b>{fmtNum(m.on_hand, t.lang)}</b>/{fmtNum(m.min_stock, t.lang)} {m.unit}
                    <span className="muted"> · {t('suggestQty')} {fmtNum(Math.max(Number(m.min_stock) * 2 - Number(m.on_hand), 1), t.lang)} {m.unit}</span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {expiring.length > 0 && (
        <section className="panel dash-panel">
          <div className="panel-head">
            <h2>{t('expiringLots')} ({expiring.length})</h2>
            <Link className="btn btn-sm" to="/inventory">{t('nav_inventory')} →</Link>
          </div>
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>{t('nav_materials')}</th><th>{t('lot')}</th><th>{t('expiry')}</th><th className="num">{t('remaining')}</th></tr></thead>
            <tbody>{expiring.map(l => (
              <tr key={l.material_id + (l.lot_no || '') + l.expiry_date}>
                <td><b>{t.pick(l)}</b></td>
                <td>{l.lot_no || '–'}</td>
                <td><ExpiryTag date={l.expiry_date} days={daysUntil(l.expiry_date)} /></td>
                <td className="num">{fmtNum(l.remaining, t.lang)} <span className="unit">{l.unit}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  )
}
