// noodle-admin-users: lets a noodle admin create and delete accounts from the Users page.
// Called from the browser with the admin's own session (Authorization: Bearer <user JWT>).
//   inspect { user_id }                      → { other_apps: [...], is_self, last_admin }
//   create  { email, password, display_name, role, customer_id?, company?, phone? }
//                                           → { user_id, existed }   (existing login: password unchanged)
//   delete  { user_id }                      → { mode: 'full' | 'noodle', other_apps }
// Logins are shared with order-app and the recipes app, so a login that is used there is never
// deleted: only its noodle access (noodle.profiles) is removed.
const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const ROLES = ['pending', 'restaurant', 'customer', 'worker', 'kiosk', 'staff', 'admin']
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }
const noodle = { ...svc, 'Accept-Profile': 'noodle', 'Content-Profile': 'noodle' }

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...noodle, ...(init.headers || {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}
const rpc = (fn: string, args: unknown) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method' }, 405)

  // who is calling, and are they a noodle admin?
  const auth = req.headers.get('Authorization') || ''
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } })
  if (!who.ok) return json({ error: 'not signed in' }, 401)
  const me = await who.json()
  const mine = await rest(`profiles?select=role&user_id=eq.${me.id}`)
  if (mine?.[0]?.role !== 'admin') return json({ error: 'admin only' }, 403)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'bad json' }, 400) }

  try {
    if (body.action === 'inspect' || body.action === 'delete') {
      const uid = String(body.user_id || '')
      if (!/^[0-9a-f-]{36}$/i.test(uid)) return json({ error: 'bad user id' }, 400)
      const other: string[] = await rpc('user_other_apps', { p_user: uid }) || []
      const target = (await rest(`profiles?select=role&user_id=eq.${uid}`))?.[0]
      const admins = await rest(`profiles?select=user_id&role=eq.admin`)
      const isSelf = uid === me.id
      const lastAdmin = target?.role === 'admin' && admins.length <= 1
      if (body.action === 'inspect') return json({ other_apps: other, is_self: isSelf, last_admin: lastAdmin })

      if (isSelf) return json({ error: 'cannot delete yourself' }, 400)
      if (lastAdmin) return json({ error: 'cannot delete the last admin' }, 400)
      if (other.length === 0) {
        const r = await fetch(`${URL_}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc })
        if (r.ok) return json({ mode: 'full', other_apps: other })
        // still referenced somewhere (e.g. history rows): fall back to removing noodle access
      }
      await rest(`profiles?user_id=eq.${uid}`, { method: 'DELETE' })
      return json({ mode: 'noodle', other_apps: other })
    }

    if (body.action === 'create') {
      const email = String(body.email || '').trim().toLowerCase()
      const role = ROLES.includes(body.role) ? body.role : 'pending'
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid email' }, 400)
      let uid: string | null = await rpc('user_id_by_email', { p_email: email })
      let existed = !!uid
      if (!uid) {
        const password = String(body.password || '')
        if (password.length < 8) return json({ error: 'password too short' }, 400)
        const r = await fetch(`${URL_}/auth/v1/admin/users`, {
          method: 'POST', headers: svc,
          body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: body.display_name || '' } }),
        })
        const created = await r.json()
        if (!r.ok) return json({ error: created?.msg || created?.message || 'could not create login' }, 400)
        uid = created.id
      }
      const exists = (await rest(`profiles?select=user_id&user_id=eq.${uid}`))?.length > 0
      if (exists && existed) return json({ error: 'already has noodle access', user_id: uid }, 409)
      await rest('profiles?on_conflict=user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: uid, role,
          customer_id: ['restaurant', 'customer'].includes(role) ? (body.customer_id || null) : null,
          display_name: body.display_name || null, company: body.company || null, phone: body.phone || null, lang: 'hu',
        }),
      })
      return json({ user_id: uid, existed })
    }
    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
