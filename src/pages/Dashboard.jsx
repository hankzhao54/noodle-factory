import { Link } from 'react-router-dom'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate } from '../lib/i18n'
import { useAuth } from '../lib/auth'
import { Loading, ErrorBox } from '../components/ui'

export default function Dashboard() {
  const t = useT()
  const { profile, isAdmin } = useAuth()
  const { data, error } = useData(async () => {
    const [newOrders, tomorrow, runs, low, batches, pos, pending] = await Promise.all([
      q(db.from('orders').select('id').eq('status', 'submitted')),
      q(db.from('orders').select('id').eq('delivery_date', todayISO(1)).neq('status', 'cancelled')),
      q(db.from('deliveries').select('id,status').eq('delivery_date', todayISO())),
      q(db.from('material_stock').select('name_zh,name_en,name_hu,on_hand,min_stock,unit').eq('below_min', true)),
      q(db.from('production_batches').select('id').eq('status', 'planned')),
      q(db.from('purchase_orders').select('id').eq('status', 'ordered')),
      isAdmin ? q(db.rpc('list_users')).then(u => u.filter(x => x.role === 'pending')) : Promise.resolve([]),
    ])
    return { newOrders, tomorrow, runs, low, batches, pos, pending }
  }, [isAdmin])

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data) return <div className="page"><Loading /></div>

  const openRuns = data.runs.filter(r => r.status !== 'done').length
  const rows = [
    { n: data.newOrders.length, label: t('newOrders'), to: '/orders', urgent: true },
    { n: data.pending.length, label: t('pendingAccounts'), to: '/users', urgent: true },
    { n: data.low.length, label: t('lowStock'), to: '/inventory', urgent: true,
      detail: data.low.slice(0, 6).map(m => `${t.pick(m)} ${fmtNum(m.on_hand, t.lang)}${m.unit}`).join(' · ') },
    { n: openRuns, label: t('todayDeliveries'), to: '/deliveries' },
    { n: data.tomorrow.length, label: t('tomorrowOrders'), to: '/production' },
    { n: data.batches.length, label: t('openBatches'), to: '/production' },
    { n: data.pos.length, label: t('openPOs'), to: '/purchasing' },
  ]
  const todo = rows.filter(r => r.n > 0)

  return (
    <div className="page">
      <div className="hello">
        <h1>{fmtDate(new Date(), t.lang)}</h1>
        <p className="muted">{profile?.display_name}</p>
      </div>
      {todo.length === 0 ? <p className="all-good">{t('allGood')}</p> : (
        <ul className="todo-list">
          {todo.map(r => (
            <li key={r.label} className={r.urgent ? 'urgent' : ''}>
              <Link to={r.to}>
                <span className="todo-n">{r.n}</span>
                <span className="todo-label">{r.label}{r.detail && <small>{r.detail}</small>}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
