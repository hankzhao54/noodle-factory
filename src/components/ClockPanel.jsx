import { useEffect, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT } from '../lib/i18n'
import { useToast, errText, Loading } from './ui'
import { clockAction, clockErrorKey, fmtTime, fmtHm, needsLocation, ACTIONS_FOR } from '../lib/clock'

// Big clock-in card for the signed-in employee (phone or own computer)
export default function ClockPanel() {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const [, tick] = useState(0)
  const { data, error, reload } = useData(() => q(db.rpc('my_clock')))
  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 30000); return () => clearInterval(id) }, [])
  if (error) return <p className="error-box">{errText(error)}</p>
  if (!data) return <Loading />
  const s = data.status
  if (!s) return <p className="note-box">{t('clkNotLinked')}</p>

  async function act(action) {
    setBusy(action)
    try {
      const r = await clockAction(action, { mode: data.mode })
      toast(t('clkDone_' + action, { time: fmtTime(new Date().toISOString()) }))
      reload()
      return r
    } catch (e) {
      const k = clockErrorKey(e)
      toast(k ? t(k) : errText(e), 'error')
    } finally { setBusy(null) }
  }

  const since = s.since ? Math.round((Date.now() - new Date(s.since)) / 60000) : null
  return (
    <section className={`clock-card state-${s.state}`} aria-live="polite">
      <p className="clock-now">{new Date().toLocaleDateString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <p className="clock-state">{t('clkState_' + s.state)}</p>
      {s.state !== 'off' && <p className="muted">{t('clkSince', { time: fmtTime(s.since), d: fmtHm(since) })}</p>}
      <p className="muted small">{t('clkWorkedToday', { d: fmtHm(s.worked_today_min) })}</p>
      {s.shifts_today?.length > 0 && <p className="small">{t('clkShiftToday')}: {s.shifts_today.map(x => `${fmtTime(x.starts_at)}–${fmtTime(x.ends_at)}`).join(', ')}</p>}
      <div className="clock-actions">
        {ACTIONS_FOR[s.state].map(a => (
          <button key={a} type="button" className={`btn clock-btn ${a === 'in' || a === 'out' ? 'btn-primary' : ''}`}
            disabled={!!busy} onClick={() => act(a)}>{busy === a ? t('clkChecking') : t('clk_' + a)}</button>
        ))}
      </div>
      {needsLocation(data.mode) && <p className="muted small">{t('clkLocationNote_' + data.mode)}</p>}
      {data.mode === 'wifi' && <p className="muted small">{t('clkWifiNote')}</p>}
    </section>
  )
}
