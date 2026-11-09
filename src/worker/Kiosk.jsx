import { useEffect, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT } from '../lib/i18n'
import { Modal, Loading, useToast, errText } from '../components/ui'
import { LangSwitch } from '../App'
import { clockAction, clockErrorKey, fmtTime, fmtHm, ACTIONS_FOR } from '../lib/clock'

// Shared clock computer (role 'kiosk'): tap your name → pick the action → enter your PIN.
// Staff can open it too at /kiosk.
export default function Kiosk({ embedded }) {
  const t = useT()
  const { signOut } = useAuth()
  const [now, setNow] = useState(new Date())
  const [pick, setPick] = useState(null)        // employee being clocked
  const { data, error, reload } = useData(() => q(db.rpc('kiosk_board')))
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => { const id = setInterval(reload, 60000); return () => clearInterval(id) }, [reload])

  return (
    <div className={`kiosk ${embedded ? 'embedded' : ''}`}>
      {!embedded && <header className="kiosk-head">
        <div className="portal-brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{t('kioskTitle')}</span></div>
        <div className="portal-tools"><LangSwitch /><button className="btn-link" onClick={signOut}>{t('signOut')}</button></div>
      </header>}
      <div className="kiosk-clock">
        <span className="kiosk-time">{now.toLocaleTimeString(t.lang === 'hu' ? 'hu-HU' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="muted">{now.toLocaleDateString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      </div>
      {error ? <p className="error-box">{errText(error)}</p> : !data ? <Loading /> : (
        <>
          <p className="muted center">{t('kioskPick')}</p>
          <div className="kiosk-grid">
            {data.employees.map(e => (
              <button key={e.employee_id} type="button" className={`kiosk-tile state-${e.state}`} onClick={() => setPick(e)}
                style={e.color ? { '--emp': e.color } : undefined} disabled={!e.has_pin}>
                <span className="kiosk-name">{e.name}</span>
                <span className="kiosk-state">{t('clkState_' + e.state)}{e.state !== 'off' && ` · ${fmtTime(e.since)}`}</span>
                {!e.has_pin && <span className="muted small">{t('kioskNoPin')}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {pick && <KioskDialog emp={pick} mode={data.mode} onClose={() => setPick(null)} onDone={() => { setPick(null); reload() }} />}
    </div>
  )
}

function KioskDialog({ emp, mode, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [action, setAction] = useState(ACTIONS_FOR[emp.state].length === 1 ? ACTIONS_FOR[emp.state][0] : null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(p = pin) {
    if (busy || p.length < 4) return
    setBusy(true); setErr('')
    try {
      const r = await clockAction(action, { mode, employeeId: emp.employee_id, pin: p })
      toast(`${emp.name}: ${t('clkDone_' + action, { time: fmtTime(new Date().toISOString()) })}` +
        (action === 'out' ? ` · ${t('clkWorkedToday', { d: fmtHm(r.worked_today_min) })}` : ''))
      onDone()
    } catch (e) {
      const k = clockErrorKey(e)
      setErr(k ? t(k) : errText(e)); setPin(''); setBusy(false)
    }
  }
  const press = d => { setErr(''); const p = (pin + d).slice(0, 6); setPin(p) }
  // keyboard on the desktop
  useEffect(() => {
    const h = e => {
      if (!action) return
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key) }
      else if (e.key === 'Backspace') { e.preventDefault(); setPin(p => p.slice(0, -1)) }
      else if (e.key === 'Enter') { e.preventDefault(); submit() }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  })

  return (
    <Modal title={emp.name} onClose={onClose}>
      <p className="muted">{t('clkState_' + emp.state)}{emp.state !== 'off' && ` · ${t('clkSince', { time: fmtTime(emp.since), d: '' })}`}</p>
      {!action ? (
        <div className="clock-actions">
          {ACTIONS_FOR[emp.state].map(a => <button key={a} type="button" className={`btn clock-btn ${a === 'out' ? 'btn-primary' : ''}`} onClick={() => setAction(a)}>{t('clk_' + a)}</button>)}
        </div>
      ) : (
        <div className="pin-pad">
          <p><b>{t('clk_' + action)}</b> · {t('enterPin')}</p>
          <div className="pin-dots" aria-label={t('enterPin')}>{[0, 1, 2, 3, 4, 5].map(i => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
          {err && <p className="error-box small" role="alert">{err}</p>}
          <div className="pin-keys">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button key={d} type="button" onClick={() => press(d)} disabled={busy}>{d}</button>)}
            <button type="button" onClick={() => setPin(p => p.slice(0, -1))} disabled={busy} aria-label="Backspace">⌫</button>
            <button type="button" onClick={() => press('0')} disabled={busy}>0</button>
            <button type="button" className="ok" onClick={() => submit()} disabled={busy || pin.length < 4}>{busy ? '…' : 'OK'}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
