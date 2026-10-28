import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { useT, fmtNum } from '../lib/i18n'

/* ---------- toast ---------- */
const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null)
  const timer = useRef()
  const show = useCallback((text, kind = 'ok') => {
    setMsg({ text, kind }); clearTimeout(timer.current)
    timer.current = setTimeout(() => setMsg(null), kind === 'error' ? 6000 : 2500)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div role="status" className={`toast toast-${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}
    </ToastCtx.Provider>
  )
}

// turn Postgres / Supabase errors into readable text
export function errText(e) {
  if (!e) return ''
  const m = e.message || String(e)
  if (/row-level security/i.test(m)) return 'No permission for this action.'
  if (/duplicate key/i.test(m)) return 'That code already exists.'
  if (/foreign key/i.test(m)) return 'It is still used elsewhere, so it cannot be deleted. Mark it inactive instead.'
  return m
}

/* ---------- modal ---------- */
export function Modal({ title, onClose, children, wide, footer }) {
  const t = useT()
  const ref = useRef()
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    ref.current?.querySelector('input,select,textarea,button')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label={t('close')}>×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

/* ---------- form bits ---------- */
export function Field({ label, children, hint, span }) {
  return (
    <label className={`field ${span ? 'span-' + span : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Empty({ children, action }) {
  const t = useT()
  return <div className="empty"><p>{children || t('nothingYet')}</p>{action}</div>
}

export function Loading() {
  const t = useT()
  return <div className="loading">{t('loading')}</div>
}

export function ErrorBox({ error }) {
  if (!error) return null
  return <div className="error-box">{errText(error)}</div>
}

export function Status({ value, prefix }) {
  const t = useT()
  return <span className={`status st-${value}`}>{t(`${prefix}_${value}`)}</span>
}

/* stock "strand": a thin bar, yellow when OK, red when below minimum */
export function Strand({ value, min, unit }) {
  const t = useT()
  const v = Number(value) || 0, m = Number(min) || 0
  const scale = Math.max(m * 2, v, 1)
  const low = m > 0 && v < m
  return (
    <div className={`strand ${low ? 'is-low' : ''}`} title={`${fmtNum(v, t.lang)} ${unit || ''}`}>
      <div className="strand-track">
        <div className="strand-fill" style={{ width: `${Math.min(100, (v / scale) * 100)}%` }} />
        {m > 0 && <div className="strand-min" style={{ left: `${(m / scale) * 100}%` }} />}
      </div>
    </div>
  )
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k}
          className={value === k ? 'tab on' : 'tab'} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  )
}

export function PageHead({ title, children }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <div className="page-actions">{children}</div>
    </div>
  )
}

// controlled number input that allows empty while typing
export function NumInput({ value, onChange, ...rest }) {
  return (
    <input type="number" inputMode="decimal" step="any" {...rest}
      value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />
  )
}

// number input that keeps local state and only commits on blur / Enter
export function BlurNum({ value, onCommit, ...rest }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => { if (v !== value && v !== null) onCommit(v) }
  return (
    <NumInput {...rest} value={v} onChange={setV} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }} />
  )
}
