import { Fragment, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty } from '../components/ui'

// Operation log (admins): every change to business data, plus errors users saw.
// Written by database triggers (019_audit_log.sql), so changes made through any screen or RPC are included.
const TABLES = ['orders', 'order_lines', 'customers', 'customer_prices', 'price_tiers', 'price_tier_prices', 'products',
  'recipe_lines', 'materials', 'suppliers', 'purchase_orders', 'purchase_order_lines', 'production_batches',
  'stock_movements', 'deliveries', 'profiles', 'settings']
const RANGES = [1, 7, 30, 90]

const short = v => {
  if (v == null || v === '') return '–'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

export default function Activity() {
  const t = useT()
  const [days, setDays] = useState(7)
  const [table, setTable] = useState('')
  const [action, setAction] = useState('')
  const [user, setUser] = useState('')
  const [text, setText] = useState('')
  const [open, setOpen] = useState(null)
  const { data, error, reload } = useData(async () => {
    let qb = db.from('audit_log').select('*').gte('at', new Date(Date.now() - days * 864e5).toISOString())
      .order('at', { ascending: false }).limit(1000)
    if (table) qb = qb.eq('table_name', table)
    if (action) qb = qb.eq('action', action)
    return q(qb)
  }, [days, table, action])

  if (error) return <div className="page"><ErrorBox error={error} /></div>

  const users = data ? [...new Set(data.map(r => r.user_email || (r.origin === 'system' ? 'system' : '')).filter(Boolean))].sort() : []
  const needle = text.trim().toLowerCase()
  const rows = (data || []).filter(r =>
    (!user || (r.user_email || 'system') === user) &&
    (!needle || `${r.label || ''} ${r.row_id || ''} ${JSON.stringify(r.changes || {})}`.toLowerCase().includes(needle)))
  const errors = (data || []).filter(r => r.action === 'error').length
  const when = iso => new Date(iso).toLocaleString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB',
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

  function summary(r) {
    if (r.action === 'error') return r.changes?.message
    if (r.action === 'update') return Object.entries(r.changes || {}).map(([k, [a, b]]) => `${k}: ${short(a)} → ${short(b)}`).join(' · ')
    return t(r.action === 'insert' ? 'acCreated' : 'acDeleted')
  }

  return (
    <div className="page">
      <PageHead title={t('nav_activity')}>
        <button type="button" className="btn btn-quiet" onClick={reload}>{t('refresh')}</button>
      </PageHead>
      <p className="muted lead">{t('acIntro')}</p>

      <div className="activity-filters">
        <div className="date-chips" role="group" aria-label={t('acRange')}>
          {RANGES.map(d => <button key={d} type="button" aria-pressed={days === d} className={days === d ? 'chip on' : 'chip'} onClick={() => setDays(d)}>{t('acDays', { n: d })}</button>)}
        </div>
        <select value={action} onChange={e => setAction(e.target.value)} aria-label={t('acAction')}>
          <option value="">{t('acAllActions')}</option>
          {['insert', 'update', 'delete', 'error'].map(a => <option key={a} value={a}>{t('ac_' + a)}</option>)}
        </select>
        <select value={table} onChange={e => setTable(e.target.value)} aria-label={t('acObject')}>
          <option value="">{t('acAllObjects')}</option>
          {TABLES.map(x => <option key={x} value={x}>{t('tbl_' + x)}</option>)}
        </select>
        <select value={user} onChange={e => setUser(e.target.value)} aria-label={t('acUser')}>
          <option value="">{t('acAllUsers')}</option>
          {users.map(u => <option key={u} value={u}>{u === 'system' ? t('acSystem') : u}</option>)}
        </select>
        <input type="search" value={text} onChange={e => setText(e.target.value)} placeholder={t('acSearch')} aria-label={t('acSearch')} />
      </div>
      {data && errors > 0 && !action && <p className="small"><button type="button" className="btn-link" onClick={() => setAction('error')}>{t('acErrorsN', { n: errors })}</button></p>}

      {!data ? <Loading /> : rows.length === 0 ? <Empty>{t('acEmpty')}</Empty> : (
        <div className="table-wrap"><table className="table activity-table">
          <thead><tr><th>{t('acTime')}</th><th>{t('acUser')}</th><th>{t('acAction')}</th><th>{t('acObject')}</th><th>{t('acWhat')}</th></tr></thead>
          <tbody>{rows.map(r => (
            <Fragment key={r.id}>
              <tr className={`ac-row ${open === r.id ? 'open' : ''}`} onClick={() => setOpen(open === r.id ? null : r.id)}
                tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpen(open === r.id ? null : r.id) }} aria-expanded={open === r.id}>
                <td className="muted small nowrap">{when(r.at)}</td>
                <td className="small">{r.user_email || <span className="muted">{t('acSystem')}</span>}</td>
                <td><span className={`ac-tag ac-${r.action}`}>{t('ac_' + r.action)}</span></td>
                <td className="small">{r.table_name ? t('tbl_' + r.table_name) : '–'}{r.label ? <> · <b>{r.label}</b></> : ''}</td>
                <td className="small ac-sum">{summary(r)}</td>
              </tr>
              {open === r.id && <tr className="ac-detail"><td colSpan={5}>
                <pre>{JSON.stringify(r.action === 'update'
                  ? Object.fromEntries(Object.entries(r.changes || {}).map(([k, [a, b]]) => [k, { old: a, new: b }]))
                  : r.changes, null, 2)}</pre>
                {r.row_id && <p className="muted small">ID: {r.row_id}</p>}
              </td></tr>}
            </Fragment>
          ))}</tbody>
        </table></div>
      )}
      {data?.length === 1000 && <p className="muted small">{t('acLimit')}</p>}
    </div>
  )
}
