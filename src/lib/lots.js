// days from today (local) until an ISO date; negative = already past
export function daysUntil(iso) {
  if (!iso) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00')
  return Math.round((d - today) / 86400000)
}
