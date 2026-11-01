import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'

const KEY = 'nf-install-dismissed'
const standalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// "Add to home screen" hint: a real install button on Android / desktop Chrome,
// short instructions on iPhone (Safari has no install button). Dismissed once = gone.
export default function InstallHint() {
  const t = useT()
  const [prompt, setPrompt] = useState(null)
  const [hidden, setHidden] = useState(() => {
    try { return standalone() || localStorage.getItem(KEY) === '1' } catch { return standalone() }
  })
  useEffect(() => {
    const onPrompt = e => { e.preventDefault(); setPrompt(e) }
    const onInstalled = () => setHidden(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  const dismiss = () => { setHidden(true); try { localStorage.setItem(KEY, '1') } catch { /* private mode */ } }

  if (hidden || (!prompt && !isIOS())) return null
  return (
    <div className="install-hint" role="note">
      <img src="/icon-192.png" alt="" width="36" height="36" />
      <div className="grow">
        <b>{t('installTitle')}</b>
        <span className="muted small">{prompt ? t('installText') : t('installIOS')}</span>
      </div>
      {prompt && <button className="btn btn-sm btn-primary" onClick={async () => {
        prompt.prompt(); const r = await prompt.userChoice.catch(() => null)
        setPrompt(null); if (r?.outcome === 'accepted') setHidden(true)
      }}>{t('install')}</button>}
      <button className="btn-icon" aria-label={t('close')} onClick={dismiss}>×</button>
    </div>
  )
}
