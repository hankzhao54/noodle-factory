import { useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty, Modal, Field, useToast, errText } from '../components/ui'
import { weekStart, addDays, localISODate, fmtTime, fmtHm, minutesBetween, combine } from '../lib/clock'
import { dayName } from '../lib/orderRules'

// Weekly schedule: employees × days. Admins add / edit shifts; staff can view.
export default function Schedule() {
  const t = useT()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const [start, setStart] = useState(() => weekStart())
  const [edit, setEdit] = useState(null)      // { shift } or { employee_id, date }
  const days = [...Array(7)].map((_, i) => addDays(start, i))
  const end = addDays(start, 7)
  const { data, error, reload } = useData(async () => {
    const [employees, shifts, entries] = await Promise.all([
      q(db.from('employees').select('id,name,color,position,active,sort').eq('active', true).order('sort').order('name')),
      q(db.from('shifts').select('*').gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at')),
      q(db.from('time_entries').select('employee_id,clock_in,clock_out').gte('clock_in', start.toISOString()).lt('clock_in', end.toISOString())),
    ])
    return { employees, shifts, entries }
  }, [start.getTime()])

  async function copyLastWeek() {
    try {
      const prev = await q(db.from('shifts').select('*').gte('starts_at', addDays(start, -7).toISOString()).lt('starts_at', start.toISOString()))
      if (!prev.length) return toast(t('nothingToCopy'), 'error')
      const week = 7 * 864e5
      const exists = new Set(data.shifts.map(s => `${s.employee_id}|${new Date(s.starts_at).getTime()}`))
      const rows = prev.map(s => ({ employee_id: s.employee_id, note: s.note,
        starts_at: new Date(new Date(s.starts_at).getTime() + week).toISOString(),
        ends_at: new Date(new Date(s.ends_at).getTime() + week).toISOString() }))
        .filter(r => !exists.has(`${r.employee_id}|${new Date(r.starts_at).getTime()}`))
      if (rows.length) await q(db.from('shifts').insert(rows))
      toast(t('copiedN', { n: rows.length })); reload()
    } catch (e) { toast(errText(e), 'error') }
  }

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  const today = localISODate(new Date())
  const shiftsOf = (emp, d) => (data?.shifts || []).filter(s => s.employee_id === emp && localISODate(new Date(s.starts_at)) === localISODate(d))
  const workedOn = (emp, d) => (data?.entries || []).some(e => e.employee_id === emp && localISODate(new Date(e.clock_in)) === localISODate(d))
  const weekMin = emp => (data?.shifts || []).filter(s => s.employee_id === emp).reduce((a, s) => a + minutesBetween(s.starts_at, s.ends_at), 0)
  const label = `${days[0].toLocaleDateString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric' })}`

  return (
    <div className="page">
      <PageHead title={t('nav_schedule')}>
        <div className="row-gap nowrap">
          <button type="button" className="btn btn-quiet" onClick={() => setStart(addDays(start, -7))} aria-label={t('prevWeek')}>‹</button>
          <button type="button" className="btn btn-quiet" onClick={() => setStart(weekStart())}>{t('thisWeek')}</button>
          <button type="button" className="btn btn-quiet" onClick={() => setStart(addDays(start, 7))} aria-label={t('nextWeek')}>›</button>
        </div>
        {isAdmin && <button type="button" className="btn btn-quiet" onClick={copyLastWeek}>{t('copyLastWeek')}</button>}
      </PageHead>
      <p className="muted lead">{label}{isAdmin ? ` · ${t('scheduleHint')}` : ''}</p>
      {!data ? <Loading /> : data.employees.length === 0 ? <Empty>{t('noEmployees')}</Empty> : (
        <div className="table-wrap"><table className="table schedule-grid">
          <thead><tr><th>{t('employee')}</th>
            {days.map(d => <th key={d.getTime()} className={localISODate(d) === today ? 'today' : ''}>{dayName(t.lang, ((d.getDay() + 6) % 7) + 1)} <span className="muted">{d.getDate()}</span></th>)}
            <th className="num">{t('hoursCol')}</th></tr></thead>
          <tbody>{data.employees.map(emp => (
            <tr key={emp.id}>
              <th scope="row"><span className="emp-name"><i style={{ background: emp.color || '#94A3B8' }} />{emp.name}</span>
                {emp.position && <div className="muted small">{emp.position}</div>}</th>
              {days.map(d => {
                const list = shiftsOf(emp.id, d)
                return (
                  <td key={d.getTime()} className={`sched-cell ${localISODate(d) === today ? 'today' : ''}`}>
                    {list.map(s => (
                      <button key={s.id} type="button" className="shift-chip" style={{ '--emp': emp.color || '#475569' }}
                        disabled={!isAdmin} onClick={() => setEdit({ shift: s })} title={s.note || ''}>
                        {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}{s.note && <span className="shift-note">{s.note}</span>}
                      </button>
                    ))}
                    {!list.length && workedOn(emp.id, d) && <span className="muted small">{t('workedNoShift')}</span>}
                    {isAdmin && <button type="button" className="cell-add" aria-label={`${t('addShift')} · ${emp.name} · ${localISODate(d)}`}
                      onClick={() => setEdit({ employee_id: emp.id, date: localISODate(d) })}>+</button>}
                  </td>
                )
              })}
              <td className="num">{fmtHm(weekMin(emp.id))}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && <ShiftDialog edit={edit} employees={data.employees} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload() }} />}
    </div>
  )
}

const hhmm = iso => fmtTime(iso)

function ShiftDialog({ edit, employees, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const s = edit.shift
  const [v, setV] = useState(() => s
    ? { employee_id: s.employee_id, date: localISODate(new Date(s.starts_at)), from: hhmm(s.starts_at), to: hhmm(s.ends_at), note: s.note || '' }
    : { employee_id: edit.employee_id, date: edit.date, from: '07:00', to: '15:00', note: '' })
  const set = (k, x) => setV(o => ({ ...o, [k]: x }))
  const [askDel, setAskDel] = useState(false)
  // end before start = ends the next day (night shift)
  const startsAt = combine(v.date, v.from)
  let endsAt = combine(v.date, v.to)
  if (new Date(endsAt) <= new Date(startsAt)) endsAt = new Date(new Date(endsAt).getTime() + 864e5).toISOString()

  async function save(e) {
    e.preventDefault()
    const row = { employee_id: v.employee_id, starts_at: startsAt, ends_at: endsAt, note: v.note || null }
    try {
      if (s) await q(db.from('shifts').update(row).eq('id', s.id))
      else await q(db.from('shifts').insert(row))
      toast(t('saved')); onDone()
    } catch (err) { toast(errText(err), 'error') }
  }
  async function remove() {
    try { await q(db.from('shifts').delete().eq('id', s.id)); toast(t('deleted')); onDone() }
    catch (err) { toast(errText(err), 'error') }
  }
  return (
    <Modal title={s ? t('editShift') : t('addShift')} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-grid">
          <Field label={t('employee')}>
            <select value={v.employee_id} onChange={e => set('employee_id', e.target.value)} required>
              {employees.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select></Field>
          <Field label={t('date')}><input type="date" value={v.date} onChange={e => set('date', e.target.value)} required /></Field>
          <Field label={t('from')}><input type="time" value={v.from} onChange={e => set('from', e.target.value)} required /></Field>
          <Field label={t('to')} hint={`${fmtHm(minutesBetween(startsAt, endsAt))}`}><input type="time" value={v.to} onChange={e => set('to', e.target.value)} required /></Field>
          <Field label={t('notes')} span={2}><input value={v.note} onChange={e => set('note', e.target.value)} placeholder={t('shiftNotePh')} /></Field>
        </div>
        {askDel && <p className="note-box">{t('confirmDelete')}</p>}
        <div className="modal-foot">
          {s && (askDel
            ? <button type="button" className="btn btn-danger" onClick={remove}>{t('confirmDeleteBtn')}</button>
            : <button type="button" className="btn btn-danger-quiet" onClick={() => setAskDel(true)}>{t('delete')}</button>)}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('save')}</button>
        </div>
      </form>
    </Modal>
  )
}
