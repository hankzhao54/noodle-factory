import { useEffect, useRef, useState } from 'react'
import { db, supabase } from '../lib/supabase'
import { useT } from '../lib/i18n'

// Signs the back office out after a period without any mouse / keyboard / touch activity,
// so a shared computer is not left logged in. Minutes come from settings.idle_logout_minutes
// (0 = never). A warning shows one minute before. Activity in any open tab counts (localStorage).
const KEY = 'nf-last-active'
const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll']
const now = () => Date.now()
const readLast = () => { try { return Number(localStorage.getItem(KEY)) || now() } catch { return now() } }
const writeLast = t => { try { localStorage.setItem(KEY, String(t)) } catch { /* private mode */ } }

export default function IdleLogout() {
  const t = useT()
  // only this browser: the same account stays signed in on other devices (phones etc.)
  const signOut = () => supabase.auth.signOut({ scope: 'local' })
  const [minutes, setMinutes] = useState(null)
  const [left, setLeft] = useState(null)          // seconds until sign-out while warning, else null
  const last = useRef(now())

  useEffect(() => {
    db.from('settings').select('value').eq('key', 'idle_logout_minutes').maybeSingle()
      .then(({ data }) => setMinutes(data?.value == null || data.value === '' ? 30 : Number(data.value) || 0))
  }, [])

  useEffect(() => {
    if (!minutes) return
    last.current = now(); writeLast(last.current)
    let lastWrite = 0
    const bump = () => {
      last.current = now()
      if (last.current - lastWrite > 5000) { lastWrite = last.current; writeLast(last.current) }   // other tabs see it
    }
    EVENTS.forEach(e => window.addEventListener(e, bump, { passive: true }))
    const timer = setInterval(() => {
      const idleMs = now() - Math.max(last.current, readLast())
      const limit = minutes * 60000
      if (idleMs >= limit) { clearInterval(timer); signOut(); return }
      setLeft(limit - idleMs <= 60000 ? Math.ceil((limit - idleMs) / 1000) : null)
    }, 1000)
    return () => { clearInterval(timer); EVENTS.forEach(e => window.removeEventListener(e, bump)) }
  }, [minutes])  // eslint-disable-line react-hooks/exhaustive-deps

  if (left == null) return null
  return (
    <div className="idle-warning" role="alertdialog" aria-live="assertive">
      <p><b>{t('idleWarnTitle')}</b></p>
      <p>{t('idleWarnText', { s: left })}</p>
      <button className="btn btn-primary" onClick={() => { last.current = now(); writeLast(last.current); setLeft(null) }}>{t('idleStay')}</button>
    </div>
  )
}
