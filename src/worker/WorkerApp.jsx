import { useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtDate } from '../lib/i18n'
import { Tabs, Loading, Empty } from '../components/ui'
import ClockPanel from '../components/ClockPanel'
import InstallHint from '../components/InstallHint'
import { LangSwitch } from '../App'
import { fmtTime, fmtHm, entryMinutes, localISODate, minutesBetween } from '../lib/clock'

// App for factory workers (role 'worker'): clock in/out, own schedule, own hours
export default function WorkerApp() {
  const t = useT()
  const { signOut, profile } = useAuth()
  const [tab, setTab] = useState('clock')
  return (
    <div className="portal worker">
      <header className="portal-head">
        <div className="portal-brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{profile?.display_name || t('appName')}</span></div>
        <div className="portal-tools"><LangSwitch /><button className="btn-link" onClick={signOut}>{t('signOut')}</button></div>
      </header>
      <InstallHint />
      <Tabs value={tab} onChange={setTab} tabs={[['clock', t('nav_clock')], ['shifts', t('mySchedule')], ['hours', t('myHours')]]} />
      {tab === 'clock' ? <ClockPanel /> : tab === 'shifts' ? <MyShifts /> : <MyHours />}
    </div>
  )
}

export function MyShifts() {
  const t = useT()
  const from = new Date(); from.setHours(0, 0, 0, 0)
  const { data } = useData(async () => {
    const me = await q(db.rpc('my_employee_id'))
    if (!me) return []
    return q(db.from('shifts').select('*').eq('employee_id', me).gte('starts_at', from.toISOString()).order('starts_at').limit(60))
  })
  if (!data) return <Loading />
  if (!data.length) return <Empty>{t('noShifts')}</Empty>
  return (
    <ul className="plain-list shift-list">
      {data.map(s => (
        <li key={s.id}>
          <b>{fmtDate(localISODate(new Date(s.starts_at)), t.lang)}</b>
          <span>{fmtTime(s.starts_at)}–{fmtTime(s.ends_at)} <span className="muted">({fmtHm(minutesBetween(s.starts_at, s.ends_at))})</span></span>
          {s.note && <span className="muted small">{s.note}</span>}
        </li>
      ))}
    </ul>
  )
}

export function MyHours() {
  const t = useT()
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const { data } = useData(async () => {
    const me = await q(db.rpc('my_employee_id'))
    if (!me) return []
    return q(db.from('time_entries').select('*, time_breaks(*)').eq('employee_id', me)
      .gte('clock_in', start.toISOString()).order('clock_in', { ascending: false }))
  })
  if (!data) return <Loading />
  const total = data.reduce((s, e) => s + entryMinutes(e).total, 0)
  return (
    <div>
      <p className="lead">{t('monthTotal')}: <b>{fmtHm(total)}</b></p>
      {!data.length ? <Empty>{t('noEntries')}</Empty> : (
        <ul className="plain-list shift-list">
          {data.map(e => {
            const m = entryMinutes(e)
            return (
              <li key={e.id}>
                <b>{fmtDate(localISODate(new Date(e.clock_in)), t.lang)}</b>
                <span>{fmtTime(e.clock_in)}–{e.clock_out ? fmtTime(e.clock_out) : t('clkOpen')} · <b>{fmtHm(m.total)}</b>
                  {m.breaks > 0 && <span className="muted"> ({t('breakShort')} {fmtHm(m.breaks)})</span>}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
