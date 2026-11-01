// Ordering rules on the client side (the database enforces the same rules in place_order).
// rules = result of rpc('order_rules'): { earliest, cutoff, lead_days, weekdays, closed_dates, my_weekdays }
// Weekdays are ISO: 1 = Monday … 7 = Sunday.

export const parseDays = s => String(s ?? '').split(',').map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= 7)
export const parseDates = s => String(s ?? '').split(/[,\s]+/).map(x => x.trim()).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x))

const isoDow = iso => { const d = new Date(iso + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d }
export const addDaysISO = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}

// '' when allowed, else a reason key: too_late | no_delivery_day | not_your_day | closed
export function dateProblem(rules, iso) {
  if (!rules || !iso) return ''
  if (iso < rules.earliest) return 'too_late'
  const dow = isoDow(iso)
  const factory = parseDays(rules.weekdays)
  if (factory.length && !factory.includes(dow)) return 'no_delivery_day'
  const mine = Array.isArray(rules.my_weekdays) ? rules.my_weekdays.map(Number) : []
  if (mine.length && !mine.includes(dow)) return 'not_your_day'
  if (parseDates(rules.closed_dates).includes(iso)) return 'closed'
  return ''
}

// the next n allowed delivery dates starting at the earliest one
export function nextDates(rules, n = 8) {
  const out = []
  if (!rules?.earliest) return out
  for (let i = 0, d = rules.earliest; i < 120 && out.length < n; i++, d = addDaysISO(d, 1)) {
    if (!dateProblem(rules, d)) out.push(d)
  }
  return out
}

// effective delivery weekdays for a customer (factory ∩ customer)
export function deliveryDays(rules) {
  const factory = parseDays(rules?.weekdays)
  const mine = Array.isArray(rules?.my_weekdays) ? rules.my_weekdays.map(Number) : []
  const all = factory.length ? factory : [1, 2, 3, 4, 5, 6, 7]
  return mine.length ? all.filter(d => mine.includes(d)) : all
}

// weekday names for 1..7 in the UI language
export function dayName(lang, d, style = 'short') {
  const base = new Date(Date.UTC(2024, 0, 1 + (d - 1))) // 2024-01-01 is a Monday
  return base.toLocaleDateString(lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en-GB' : 'hu-HU', { weekday: style, timeZone: 'UTC' })
}
