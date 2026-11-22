// noodle-costs: labour hours and wages of the noodle factory (location "101 Pastafactory") from 101base (ShiftDesk),
// for the Costs page. Only people listed in noodle.cost_viewers get an answer.
//   POST { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } → { rows: [{ day, person, hours, hourly_wage, pay_type, open_card }] }
// 101base side: public.integration_pastafactory_labor(p_token, p_from, p_to), callable with 101base's publishable
// key plus a shared token. The token is kept in noodle.integration_secrets (name 'labor_101base_token'),
// readable only with the service role.
const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const BASE_URL = 'https://rwineoyuhzwqtarnzkpq.supabase.co'
const BASE_KEY = 'sb_publishable_sIVZd8Z22IIWaOfpvwMRsA_3J6UkbjT' // publishable (public) key of 101base

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const noodle = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Accept-Profile': 'noodle' }
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method' }, 405)

  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: req.headers.get('Authorization') || '' } })
  if (!who.ok) return json({ error: 'not signed in' }, 401)
  const me = await who.json()
  const v = await fetch(`${URL_}/rest/v1/cost_viewers?select=user_id&user_id=eq.${me.id}`, { headers: noodle })
  if (!v.ok || !(await v.json()).length) return json({ error: 'not allowed' }, 403)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  if (!isDate(body?.from) || !isDate(body?.to)) return json({ error: 'from / to' }, 400)

  const s = await fetch(`${URL_}/rest/v1/integration_secrets?select=value&name=eq.labor_101base_token`, { headers: noodle })
  const token = s.ok ? (await s.json())?.[0]?.value : null
  if (!token) return json({ error: '101base token missing' }, 500)

  const r = await fetch(`${BASE_URL}/rest/v1/rpc/integration_pastafactory_labor`, {
    method: 'POST',
    headers: { apikey: BASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token, p_from: body.from, p_to: body.to }),
  })
  const text = await r.text()
  if (!r.ok) return json({ error: `101base: ${r.status} ${text.slice(0, 200)}` }, 502)
  return json({ rows: JSON.parse(text) })
})
