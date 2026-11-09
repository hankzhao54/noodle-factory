import { useState } from 'react'
import { db, q, supabase } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty, Modal, Field, useToast, errText } from '../components/ui'

const LINKED = ['restaurant', 'customer']
const TYPE_FOR = { restaurant: 'internal', customer: 'wholesale' }

// calls the admin-only server function (creates / deletes logins with the service key)
export async function adminUsers(body) {
  const { data, error } = await supabase.functions.invoke('noodle-admin-users', { body })
  if (error) {
    let msg = error.message
    try { msg = (await error.context.json()).error || msg } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return data
}
const APP_NAME = { ordering: 'order-app', public: 'Recipes app' }

export default function Users() {
  const t = useT()
  const toast = useToast()
  const { session } = useAuth()
  const myId = session?.user?.id
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)
  const { data, loading, error, reload } = useData(async () => {
    const [users, customers, locs, stores] = await Promise.all([
      q(db.rpc('list_users')),
      q(db.from('customers').select('id,name,type').eq('active', true).order('name')),
      q(db.from('profiles').select('user_id,location_id')),
      q(db.from('customer_locations').select('id,customer_id,name').eq('active', true).order('sort').order('name')),
    ])
    const locOf = Object.fromEntries(locs.map(x => [x.user_id, x.location_id]))
    return { users: users.map(u => ({ ...u, location_id: locOf[u.user_id] || null })), customers, stores }
  })
  async function update(u, patch) {
    const next = { role: u.role, customer_id: u.customer_id, location_id: u.location_id, ...patch }
    const linked = data.customers.find(c => c.id === next.customer_id)
    if (!LINKED.includes(next.role) || (linked && linked.type !== TYPE_FOR[next.role])) next.customer_id = null
    if (!data.stores.some(l => l.id === next.location_id && l.customer_id === next.customer_id)) next.location_id = null
    try { await q(db.from('profiles').update(next).eq('user_id', u.user_id)); toast(t('saved')); reload() }
    catch (e) { toast(errText(e), 'error') }
  }
  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>
  return (
    <div className="page">
      <PageHead title={t('nav_users')}>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>{t('addAccount')}</button>
      </PageHead>
      <p className="muted lead">{t('usersHint')}</p>
      {data.users.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('company')}</th><th>{t('role')}</th><th>{t('linkCustomer')}</th><th>{t('date')}</th><th /></tr></thead>
          <tbody>{data.users.map(u => (
            <tr key={u.user_id} className={u.role === 'pending' ? 'row-todo' : ''}>
              <td><b>{u.display_name || '–'}</b>{u.phone ? <div className="muted small">{u.phone}</div> : null}</td>
              <td>{u.email}</td>
              <td>{u.company || '–'}</td>
              <td>
                <select value={u.role} onChange={e => update(u, { role: e.target.value })} aria-label={t('role')}>
                  {['pending', 'restaurant', 'customer', 'worker', 'kiosk', 'staff', 'admin'].map(r => <option key={r} value={r}>{t('role_' + r)}</option>)}
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
                {LINKED.includes(u.role) && data.stores.some(l => l.customer_id === u.customer_id) && (
                  <select className="store-select" value={u.location_id || ''} onChange={e => update(u, { location_id: e.target.value || null })}
                    aria-label={t('storeAccess')}>
                    <option value="">{t('allStores')}</option>
                    {data.stores.filter(l => l.customer_id === u.customer_id).map(l => <option key={l.id} value={l.id}>{t('onlyStore', { s: l.name })}</option>)}
                  </select>)}
              </td>
              <td className="muted nowrap">{fmtDate(u.created_at, t.lang)}</td>
              <td className="act">{u.user_id !== myId &&
                <button className="btn btn-danger-quiet btn-sm" onClick={() => setRemoving(u)}>{t('delete')}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {adding && <AddAccount customers={data.customers} onClose={() => setAdding(false)}
        onDone={() => { setAdding(false); reload() }} />}
      {removing && <RemoveAccount user={removing} onClose={() => setRemoving(null)}
        onDone={() => { setRemoving(null); reload() }} />}
    </div>
  )
}

const genPassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const a = new Uint32Array(12); crypto.getRandomValues(a)
  return Array.from(a, x => chars[x % chars.length]).join('')
}

function AddAccount({ customers, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [v, setV] = useState({ email: '', display_name: '', password: genPassword(), role: 'restaurant', customer_id: '', company: '', phone: '' })
  const [busy, setBusy] = useState(false)
  const set = (k, val) => setV(s => ({ ...s, [k]: val }))
  const linked = LINKED.includes(v.role)
  const options = customers.filter(c => c.type === TYPE_FOR[v.role])
  async function save(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await adminUsers({ action: 'create', ...v, customer_id: linked ? v.customer_id || null : null })
      toast(r.existed ? t('accountExistedAdded') : t('accountCreated')); onDone()
    } catch (err) {
      toast(/already has noodle access/.test(err.message) ? t('accountAlreadyHere') : errText(err), 'error'); setBusy(false)
    }
  }
  return (
    <Modal title={t('addAccount')} onClose={onClose}>
      <form className="form-grid" onSubmit={save} id="add-account">
        <Field label={t('email')} span={2}><input type="email" required autoComplete="off" value={v.email} onChange={e => set('email', e.target.value)} /></Field>
        <Field label={t('name')}><input value={v.display_name} onChange={e => set('display_name', e.target.value)} /></Field>
        <Field label={t('phone')}><input value={v.phone} onChange={e => set('phone', e.target.value)} /></Field>
        <div className="field span-2">
          <label className="field-label" htmlFor="new-pw">{t('initialPassword')}</label>
          <span className="row-gap">
            <input id="new-pw" value={v.password} minLength={8} required autoComplete="new-password" aria-describedby="new-pw-hint"
              onChange={e => set('password', e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => set('password', genPassword())}>{t('generate')}</button>
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(v.password).then(() => toast(t('copied')))}>{t('copy')}</button>
          </span>
          <span className="field-hint" id="new-pw-hint">{t('initialPasswordHint')}</span>
        </div>
        <Field label={t('role')}>
          <select value={v.role} onChange={e => setV(s => ({ ...s, role: e.target.value, customer_id: '' }))}>
            {['restaurant', 'customer', 'worker', 'kiosk', 'staff', 'admin'].map(r => <option key={r} value={r}>{t('role_' + r)}</option>)}
          </select>
        </Field>
        {linked ? (
          <Field label={t('linkCustomer')} hint={options.length ? null : t('noCustomerOfType')}>
            <select value={v.customer_id} required onChange={e => set('customer_id', e.target.value)}>
              <option value="">–</option>
              {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        ) : <Field label={t('company')}><input value={v.company} onChange={e => set('company', e.target.value)} /></Field>}
      </form>
      <div className="modal-foot"><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" form="add-account" disabled={busy}>{t('addAccount')}</button>
      </div>
    </Modal>
  )
}

function RemoveAccount({ user, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const { data, error } = useData(() => adminUsers({ action: 'inspect', user_id: user.user_id }), [user.user_id])
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    try {
      const r = await adminUsers({ action: 'delete', user_id: user.user_id })
      toast(r.mode === 'full' ? t('accountDeleted') : t('accessRemoved')); onDone()
    } catch (err) { toast(errText(err), 'error'); setBusy(false) }
  }
  const other = data?.other_apps || []
  const blocked = data && (data.is_self || data.last_admin)
  return (
    <Modal title={`${t('delete')} · ${user.email}`} onClose={onClose}>
      <ErrorBox error={error} />
      {!data && !error ? <Loading /> : data && (
        blocked ? <p className="error-box">{t(data.is_self ? 'cannotDeleteSelf' : 'cannotDeleteLastAdmin')}</p>
        : other.length > 0 ? <p className="note-box">{t('removeAccessOnly', { apps: other.map(a => APP_NAME[a] || a).join(', ') })}</p>
        : <p className="note-box">{t('deleteFully')}</p>
      )}
      <div className="modal-foot"><span className="grow" />
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-danger" disabled={!data || blocked || busy} onClick={go}>
          {other.length > 0 ? t('removeAccess') : t('deleteAccount')}</button>
      </div>
    </Modal>
  )
}
