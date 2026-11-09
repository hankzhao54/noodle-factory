import { db, q } from './supabase'

// ---------- time helpers (local time = Budapest on the factory's devices) ----------
const pad = n => String(n).padStart(2, '0')
export const localISODate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const fmtTime = iso => { if (!iso) return '–'; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
export const fmtHm = min => {
  if (min == null || isNaN(min)) return '–'
  const m = Math.max(0, Math.round(min)), h = Math.floor(m / 60)
  return h ? `${h}h ${pad(m % 60)}m` : `${m % 60}m`
}
export const hours = min => Math.round((min || 0) / 6) / 10        // 1 decimal
export function weekStart(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))                   // Monday
  return x
}
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000
// "2026-11-09" + "08:30" → ISO string in local time
export const combine = (dateISO, hhmm) => new Date(`${dateISO}T${hhmm}:00`).toISOString()

// worked minutes of an entry (breaks subtracted); open entries count until now
export function entryMinutes(e, now = new Date()) {
  const end = e.clock_out ? new Date(e.clock_out) : now
  const total = (end - new Date(e.clock_in)) / 60000
  const br = (e.time_breaks || []).reduce((s, b) => s + ((b.ends_at ? new Date(b.ends_at) : now) - new Date(b.starts_at)) / 60000, 0)
  return { total: Math.max(0, total - br), breaks: br }
}

// ---------- clock rules ----------
export const needsLocation = mode => ['location', 'either', 'both'].includes(mode)

// browser position, or null (denied / unavailable / timeout)
export function getPosition(timeout = 12000) {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 })
  })
}

// clock in/out/break; collects the location when the rule may need it
export async function clockAction(action, { mode, employeeId, pin } = {}) {
  const pos = needsLocation(mode) ? await getPosition() : null
  const res = await q(db.rpc('clock_action', {
    p_action: action, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_acc: pos?.acc ?? null,
    p_employee: employeeId ?? null, p_pin: pin ?? null,
  }))
  if (res?.error) throw new Error(res.error)
  return res
}

// error from clock_action → i18n key
export function clockErrorKey(e) {
  const m = e?.message || String(e)
  const w = /not at workplace: (\w+)/.exec(m)
  if (w) return 'clk_' + w[1]
  for (const k of ['wrong pin', 'pin locked', 'pin not set', 'already clocked in', 'not clocked in', 'already on break', 'not on break', 'no employee record'])
    if (m.includes(k)) return 'clk_' + k.replace(/ /g, '_')
  return null
}

export const ACTIONS_FOR = { off: ['in'], in: ['break_start', 'out'], break: ['break_end', 'out'] }
