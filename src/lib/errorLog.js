import { db } from './supabase'

// Sends errors the user saw to the operation log (noodle.audit_log, action 'error').
// The same message is sent at most once a minute; nothing is sent when signed out (the database ignores it).
const recent = new Map()
export function logError(message, context) {
  const msg = String(message || '').slice(0, 1000)
  if (!msg) return
  const now = Date.now()
  if (now - (recent.get(msg) || 0) < 60000) return
  recent.set(msg, now)
  try {
    db.rpc('log_client_error', { p_message: msg, p_path: location.pathname, p_context: context || null })
      .then(() => {}, () => {})
  } catch { /* never let logging break the app */ }
}

export function installErrorLogging() {
  window.addEventListener('error', e => logError(e.message, { source: 'window', file: e.filename, line: e.lineno }))
  window.addEventListener('unhandledrejection', e => logError(e.reason?.message || String(e.reason), { source: 'promise' }))
}
