import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty, useToast, errText } from '../components/ui'

const LINKED = ['restaurant', 'customer']
const TYPE_FOR = { restaurant: 'internal', customer: 'wholesale' }

export default function Users() {
  const t = useT()
  const toast = useToast()
  const { data, loading, error, reload } = useData(async () => {
    const [users, customers] = await Promise.all([
      q(db.rpc('list_users')),
      q(db.from('customers').select('id,name,type').eq('active', true).order('name')),
    ])
    return { users, customers }
  })
  async function update(u, patch) {
    const next = { role: u.role, customer_id: u.customer_id, ...patch }
    const linked = data.customers.find(c => c.id === next.customer_id)
    if (!LINKED.includes(next.role) || (linked && linked.type !== TYPE_FOR[next.role])) next.customer_id = null
    try { await q(db.from('profiles').update(next).eq('user_id', u.user_id)); toast(t('saved')); reload() }
    catch (e) { toast(errText(e), 'error') }
  }
  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>
  return (
    <div className="page">
      <PageHead title={t('nav_users')} />
      <p className="muted lead">{t('usersHint')}</p>
      {data.users.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('company')}</th><th>{t('role')}</th><th>{t('linkCustomer')}</th><th>{t('date')}</th></tr></thead>
          <tbody>{data.users.map(u => (
            <tr key={u.user_id} className={u.role === 'pending' ? 'row-todo' : ''}>
              <td><b>{u.display_name || '–'}</b>{u.phone ? <div className="muted small">{u.phone}</div> : null}</td>
              <td>{u.email}</td>
              <td>{u.company || '–'}</td>
              <td>
                <select value={u.role} onChange={e => update(u, { role: e.target.value })} aria-label={t('role')}>
                  {['pending', 'restaurant', 'customer', 'staff', 'admin'].map(r => <option key={r} value={r}>{t('role_' + r)}</option>)}
                </select>
              </td>
              <td>
                {LINKED.includes(u.role) ? (
                  <select value={u.customer_id || ''} onChange={e => update(u, { customer_id: e.target.value || null })}
                    aria-label={t('linkCustomer')} className={!u.customer_id ? 'is-missing' : ''}>
                    <option value="">–</option>
                    {data.customers.filter(c => c.type === TYPE_FOR[u.role]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : <span className="muted">–</span>}
              </td>
              <td className="muted nowrap">{fmtDate(u.created_at, t.lang)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}
