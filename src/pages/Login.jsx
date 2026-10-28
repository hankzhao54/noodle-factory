import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useT } from '../lib/i18n'
import { LangSwitch } from '../App'

export default function Login() {
  const t = useT()
  const [mode, setMode] = useState('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault(); setBusy(true); setMsg(null)
    // emailRedirectTo: the confirmation link must come back to this app,
    // not to the shared Supabase "Site URL" (used by the other apps)
    const { data, error } = mode === 'in'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
    setBusy(false)
    if (error) setMsg({ kind: 'error', text: error.message })
    else if (mode === 'up' && !data.session) setMsg({ kind: 'ok', text: t('checkEmail') })
  }

  return (
    <div className="login">
      <div className="login-art" aria-hidden="true">
        <svg viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 18 }).map((_, i) => (
            <path key={i} d={`M-20 ${30 + i * 32} C 80 ${10 + i * 32}, 140 ${60 + i * 32}, 220 ${32 + i * 32} S 360 ${8 + i * 32}, 430 ${36 + i * 32}`}
              fill="none" stroke="#E3B12C" strokeOpacity={0.25 + (i % 4) * 0.18} strokeWidth="3" strokeLinecap="round" />
          ))}
        </svg>
      </div>
      <div className="login-panel">
        <div className="login-top"><LangSwitch /></div>
        <form className="login-form" onSubmit={submit}>
          <img src="/icon.svg" alt="" width="44" height="44" />
          <h1>{t('appName')}</h1>
          <p className="muted">{t('loginTagline')}</p>
          <label className="field"><span className="field-label">{t('email')}</span>
            <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t('password')}</span>
            <input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={6} required
              value={password} onChange={e => setPassword(e.target.value)} /></label>
          {msg && <p className={msg.kind === 'error' ? 'error-box' : 'ok-box'}>{msg.text}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>{mode === 'in' ? t('signIn') : t('signUp')}</button>
          <button type="button" className="btn-link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(null) }}>
            {mode === 'in' ? t('noAccount') : t('haveAccount')}
          </button>
        </form>
      </div>
    </div>
  )
}
