import { useState } from 'react'
import { db } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useT } from '../lib/i18n'
import { LangSwitch } from '../App'
import { Field, errText } from '../components/ui'

export default function RequestAccess({ profile }) {
  const t = useT()
  const { reloadProfile, signOut, session } = useAuth()
  const [v, setV] = useState({ name: '', company: '', phone: '' })
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const { error } = await db.rpc('request_access', { p_name: v.name, p_company: v.company, p_phone: v.phone, p_lang: t.lang })
    if (error) setErr(errText(error)); else reloadProfile()
  }

  return (
    <div className="center-screen">
      <div className="card-plain narrow">
        <div className="row-between"><img src="/icon.svg" alt="" width="36" height="36" /><LangSwitch /></div>
        {profile ? (<>
          <h1>{t('pendingTitle')}</h1>
          <p className="muted">{t('pendingText')}</p>
          <p className="muted small">{session.user.email}</p>
          <div className="row-gap">
            <button className="btn btn-primary" onClick={reloadProfile}>{t('refresh')}</button>
            <button className="btn" onClick={signOut}>{t('signOut')}</button>
          </div>
        </>) : (
          <form onSubmit={submit} className="stack">
            <h1>{t('requestAccess')}</h1>
            <p className="muted">{t('requestAccessHint')}</p>
            <Field label={t('yourName')}><input required value={v.name} onChange={e => setV({ ...v, name: e.target.value })} /></Field>
            <Field label={t('company')}><input required value={v.company} onChange={e => setV({ ...v, company: e.target.value })} /></Field>
            <Field label={t('phone')}><input type="tel" value={v.phone} onChange={e => setV({ ...v, phone: e.target.value })} /></Field>
            {err && <p className="error-box">{err}</p>}
            <div className="row-gap">
              <button className="btn btn-primary">{t('send')}</button>
              <button type="button" className="btn" onClick={signOut}>{t('signOut')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
