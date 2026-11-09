import { Fragment, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty, Modal, Field, useToast, errText } from '../components/ui'
import { weekStart, addDays, localISODate, fmtTime, fmtHm, hours, entryMinutes, minutesBetween, combine } from '../lib/clock'

const LATE_GRACE_MIN = 5

function downloadCsv(name, head, rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const text = '﻿' + [head, ...rows].map(r => r.map(esc).join(';')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  a.download = `${name}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// Hours per employee for a period, compared with the schedule. Admins can correct entries.
export default function Timesheets() {
  const t = useT()
  const { isAdmin } = useAuth()
  const now = new Date()
  const presets = [
    ['thisWeek', weekStart(), addDays(weekStart(), 7)],
    ['lastWeek', addDays(weekStart(), -7), weekStart()],
    ['thisMonth', new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)],
    ['lastMonth', new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)],
  ]
  const [range, setRange] = useState('thisMonth')
  const [, from, to] = presets.find(p => p[0] === range)
  const [openEmp, setOpenEmp] = useState(null)
  const [edit, setEdit] = useState(null)
  const { data, error, reload } = useData(async () => {
    const [employees, entries, shifts] = await Promise.all([
      q(db.from('employees').select('id,name,color,active,sort').order('sort').order('name')),
      q(db.from('time_entries').select('*, time_breaks(*)').gte('clock_in', from.toISOString()).lt('clock_in', to.toISOString()).order('clock_in')),
      q(db.from('shifts').select('*').gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).order('starts_at')),
    ])
    return { employees, entries, shifts }
  }, [range])

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data) return <div className="page"><Loading /></div>

  // match each entry with the shift that starts on the same day
  // late = first clock-in of the day vs shift start; early = last clock-out vs shift end
  const rowsFor = emp => data.entries.filter(e => e.employee_id === emp.id).map((e, i, list) => {
    const day = localISODate(new Date(e.clock_in))
    const shift = data.shifts.find(s => s.employee_id === emp.id && localISODate(new Date(s.starts_at)) === day)
    const m = entryMinutes(e)
    const sameDay = list.filter(x => localISODate(new Date(x.clock_in)) === day)
    const first = sameDay[0] === e, last = sameDay[sameDay.length - 1] === e
    const late = shift && first ? Math.round(minutesBetween(shift.starts_at, e.clock_in)) : null
    const early = shift && last && e.clock_out ? Math.round(minutesBetween(e.clock_out, shift.ends_at)) : null
    return { e, day, shift, m, late: late > LATE_GRACE_MIN ? late : 0, early: early > LATE_GRACE_MIN ? early : 0,
             long: !e.clock_out && minutesBetween(e.clock_in, new Date()) > 14 * 60 }
  })
  const summary = data.employees.map(emp => {
    const rows = rowsFor(emp)
    const sched = data.shifts.filter(s => s.employee_id === emp.id).reduce((a, s) => a + minutesBetween(s.starts_at, s.ends_at), 0)
    return { emp, rows, days: new Set(rows.map(r => r.day)).size, worked: rows.reduce((a, r) => a + r.m.total, 0),
             breaks: rows.reduce((a, r) => a + r.m.breaks, 0), sched, late: rows.filter(r => r.late).length,
             open: rows.filter(r => !r.e.clock_out).length, long: rows.some(r => r.long) }
  }).filter(x => x.rows.length || x.sched || x.emp.active)
  const total = summary.reduce((a, x) => a + x.worked, 0)
  const file = `timesheet_${localISODate(from)}_${localISODate(addDays(to, -1))}`

  function exportCsv() {
    downloadCsv(file, [t('employee'), t('date'), t('clockIn'), t('clockOut'), t('breakShort'), t('workedH'), t('scheduled'), t('lateMin'), t('notes')],
      summary.flatMap(x => x.rows.map(r => [x.emp.name, r.day, fmtTime(r.e.clock_in), r.e.clock_out ? fmtTime(r.e.clock_out) : '',
        Math.round(r.m.breaks), hours(r.m.total).toString().replace('.', ','),
        r.shift ? `${fmtTime(r.shift.starts_at)}-${fmtTime(r.shift.ends_at)}` : '', r.late || '', r.e.note || ''])))
  }

  return (
    <div className="page">
      <PageHead title={t('nav_timesheets')}>
        {isAdmin && <button type="button" className="btn btn-quiet" onClick={() => setEdit({ new: true })}>{t('addEntry')}</button>}
        <button type="button" className="btn btn-quiet" onClick={exportCsv} disabled={!data.entries.length}>CSV ↓</button>
      </PageHead>
      <div className="date-chips">{presets.map(([k]) => (
        <button key={k} type="button" className={range === k ? 'chip on' : 'chip'} onClick={() => setRange(k)}>{t(k)}</button>))}</div>
      <p className="muted lead">{fmtDate(localISODate(from), t.lang)} – {fmtDate(localISODate(addDays(to, -1)), t.lang)} · {t('totalHours')}: <b>{fmtHm(total)}</b></p>

      {summary.length === 0 ? <Empty>{t('noEntries')}</Empty> : (
        <div className="table-wrap"><table className="table timesheet">
          <thead><tr><th>{t('employee')}</th><th className="num">{t('daysWorked')}</th><th className="num">{t('worked')}</th>
            <th className="num">{t('breakShort')}</th><th className="num">{t('scheduled')}</th><th className="num">{t('lateTimes')}</th><th></th></tr></thead>
          <tbody>{summary.map(x => (
            <Fragment key={x.emp.id}>
              <tr className="ac-row" onClick={() => setOpenEmp(openEmp === x.emp.id ? null : x.emp.id)} aria-expanded={openEmp === x.emp.id}>
                <td><span className="emp-name"><i style={{ background: x.emp.color || '#94A3B8' }} />{x.emp.name}</span></td>
                <td className="num">{x.days}</td>
                <td className="num"><b>{fmtHm(x.worked)}</b> <span className="muted small">({hours(x.worked)} h)</span></td>
                <td className="num muted">{fmtHm(x.breaks)}</td>
                <td className="num muted">{x.sched ? fmtHm(x.sched) : '–'}</td>
                <td className="num">{x.late ? <span className="tag tag-low">{x.late}</span> : '–'}</td>
                <td className="small">{x.long ? <span className="tag tag-low">{t('forgotClockOut')}</span> : x.open ? <span className="tag">{t('clkState_in')}</span> : ''}</td>
              </tr>
              {openEmp === x.emp.id && <tr className="ac-detail"><td colSpan={7}>
                {x.rows.length === 0 ? <p className="muted small">{t('noEntries')}</p> : (
                  <table className="table compact">
                    <thead><tr><th>{t('date')}</th><th>{t('clockIn')}</th><th>{t('clockOut')}</th><th className="num">{t('breakShort')}</th>
                      <th className="num">{t('worked')}</th><th>{t('scheduled')}</th><th>{t('howClocked')}</th><th></th></tr></thead>
                    <tbody>{x.rows.map(r => (
                      <tr key={r.e.id}>
                        <td className="nowrap">{fmtDate(r.day, t.lang)}</td>
                        <td>{fmtTime(r.e.clock_in)}{r.late > 0 && <span className="tag tag-low"> +{r.late}′</span>}</td>
                        <td>{r.e.clock_out ? fmtTime(r.e.clock_out) : <span className={r.long ? 'tag tag-low' : 'muted'}>{t('clkOpen')}</span>}
                          {r.early > 0 && <span className="tag tag-low"> −{r.early}′</span>}</td>
                        <td className="num muted">{r.m.breaks ? fmtHm(r.m.breaks) : '–'}</td>
                        <td className="num"><b>{fmtHm(r.m.total)}</b></td>
                        <td className="muted small">{r.shift ? `${fmtTime(r.shift.starts_at)}–${fmtTime(r.shift.ends_at)}` : '–'}</td>
                        <td className="muted small" title={JSON.stringify(r.e.check_in || {})}>{t('src_' + r.e.source_in)}{r.e.check_in?.by ? ` · ${t('by_' + r.e.check_in.by)}` : ''}{r.e.note ? ` · ${r.e.note}` : ''}</td>
                        <td>{isAdmin && <button type="button" className="btn-link" onClick={() => setEdit({ entry: r.e, emp: x.emp })}>{t('edit')}</button>}</td>
                      </tr>
                    ))}</tbody>
                  </table>)}
              </td></tr>}
            </Fragment>
          ))}</tbody>
        </table></div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>{t('timesheetHint', { n: LATE_GRACE_MIN })}</p>
      {edit && <EntryDialog edit={edit} employees={data.employees.filter(e => e.active)} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload() }} />}
    </div>
  )
}

// admin correction: change times, note, or add / delete an entry (all changes are in the operation log)
function EntryDialog({ edit, employees, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const e0 = edit.entry
  const [v, setV] = useState(() => e0 ? {
    employee_id: e0.employee_id, date: localISODate(new Date(e0.clock_in)), from: fmtTime(e0.clock_in),
    to: e0.clock_out ? fmtTime(e0.clock_out) : '', breakMin: Math.round(entryMinutes(e0).breaks), note: e0.note || '' }
    : { employee_id: employees[0]?.id || '', date: localISODate(new Date()), from: '07:00', to: '15:00', breakMin: 0, note: '' })
  const set = (k, x) => setV(o => ({ ...o, [k]: x }))
  const [askDel, setAskDel] = useState(false)

  async function save(ev) {
    ev.preventDefault()
    const clockIn = combine(v.date, v.from)
    let clockOut = v.to ? combine(v.date, v.to) : null
    if (clockOut && new Date(clockOut) <= new Date(clockIn)) clockOut = new Date(new Date(clockOut).getTime() + 864e5).toISOString()
    const row = { employee_id: v.employee_id, clock_in: clockIn, clock_out: clockOut, note: v.note || null }
    try {
      let id = e0?.id
      if (id) await q(db.from('time_entries').update({ ...row, source_out: clockOut && !e0.clock_out ? 'admin' : e0.source_out }).eq('id', id))
      else id = (await q(db.from('time_entries').insert({ ...row, source_in: 'admin', source_out: clockOut ? 'admin' : null }).select('id').single())).id
      // breaks: replaced by one break of the given length if it was changed
      const oldBreak = e0 ? Math.round(entryMinutes(e0).breaks) : 0
      if (Number(v.breakMin || 0) !== oldBreak) {
        await q(db.from('time_breaks').delete().eq('entry_id', id))
        if (Number(v.breakMin) > 0) {
          const bStart = new Date(new Date(clockIn).getTime() + 4 * 3600e3).toISOString()
          await q(db.from('time_breaks').insert({ entry_id: id, starts_at: bStart,
            ends_at: new Date(new Date(bStart).getTime() + Number(v.breakMin) * 60000).toISOString() }))
        }
      }
      toast(t('saved')); onDone()
    } catch (err) { toast(errText(err), 'error') }
  }
  async function remove() {
    try { await q(db.from('time_entries').delete().eq('id', e0.id)); toast(t('deleted')); onDone() }
    catch (err) { toast(errText(err), 'error') }
  }
  return (
    <Modal title={e0 ? `${t('editEntry')} · ${edit.emp?.name || ''}` : t('addEntry')} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-grid">
          {!e0 && <Field label={t('employee')}>
            <select value={v.employee_id} onChange={e => set('employee_id', e.target.value)} required>
              {employees.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select></Field>}
          <Field label={t('date')}><input type="date" value={v.date} onChange={e => set('date', e.target.value)} required /></Field>
          <Field label={t('clockIn')}><input type="time" value={v.from} onChange={e => set('from', e.target.value)} required /></Field>
          <Field label={t('clockOut')} hint={t('clockOutEmptyHint')}><input type="time" value={v.to} onChange={e => set('to', e.target.value)} /></Field>
          <Field label={t('breakMinutes')}><input type="number" min="0" value={v.breakMin} onChange={e => set('breakMin', e.target.value)} /></Field>
          <Field label={t('notes')} span={2}><input value={v.note} onChange={e => set('note', e.target.value)} placeholder={t('entryNotePh')} /></Field>
        </div>
        <p className="muted small">{t('entryEditHint')}</p>
        {askDel && <p className="note-box">{t('confirmDelete')}</p>}
        <div className="modal-foot">
          {e0 && (askDel
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
