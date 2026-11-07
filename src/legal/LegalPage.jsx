import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useT } from '../lib/i18n'
import { usePublicInfo } from '../lib/publicInfo'
import { Loading } from '../components/ui'
import { DOCS } from './content'

export const LEGAL = [['impresszum', 'legalImpresszum'], ['aszf', 'legalTerms'], ['adatvedelem', 'legalPrivacy']]

// Small footer with the three legal links (Login, access request, portal)
export function LegalLinks({ className = '' }) {
  const t = useT()
  return (
    <nav className={`legal-links ${className}`} aria-label={t('legalNav')}>
      {LEGAL.map(([k, label]) => <a key={k} href={`/legal/${k}`} target="_blank" rel="noopener">{t(label)}</a>)}
    </nav>
  )
}

// Public page: /legal/impresszum | /legal/aszf | /legal/adatvedelem — readable without signing in.
// Hungarian is binding; English is a courtesy translation (Chinese UI shows English).
export default function LegalPage() {
  const t = useT()
  const { doc } = useParams()
  const info = usePublicInfo()
  const [lang, setLang] = useState(t.lang === 'hu' ? 'hu' : 'en')
  const build = DOCS[doc] || DOCS.impresszum
  if (!info) return <div className="center-screen"><Loading /></div>
  const d = build(info, lang)
  return (
    <div className="legal">
      <header className="legal-head">
        <a href="/" className="legal-brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{info.company_name}</span></a>
        <div className="lang-switch" role="group" aria-label="Language">
          {[['hu', 'HU'], ['en', 'EN']].map(([c, l]) => (
            <button key={c} type="button" aria-pressed={lang === c} className={lang === c ? 'on' : ''} onClick={() => setLang(c)}>{l}</button>
          ))}
        </div>
      </header>
      <nav className="legal-tabs" aria-label={t('legalNav')}>
        {LEGAL.map(([k, label]) => <Link key={k} to={`/legal/${k}`} className={k === doc ? 'on' : ''}>{t(label)}</Link>)}
      </nav>
      <article className="legal-body">
        <h1>{d.title}</h1>
        {d.intro && <p className="muted">{d.intro}</p>}
        {d.sections.map(s => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((p, i) => Array.isArray(p)
              ? <ul key={i}>{p.map((x, j) => <li key={j}>{x}</li>)}</ul>
              : <p key={i}>{p}</p>)}
          </section>
        ))}
        {lang === 'en' && <p className="muted small">This English text is a courtesy translation. The Hungarian version is binding.</p>}
      </article>
    </div>
  )
}
