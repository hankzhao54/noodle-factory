// noodle-order-email: called by the orders trigger (pg_net) when an order is placed or confirmed.
// Auth: the trigger sends a shared secret (x-noodle-hook) that the database checks in order_email_payload().
// Secrets needed: RESEND_API_KEY (set in Supabase → Edge Functions → Secrets). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { buildEmails } from './email.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND = Deno.env.get('RESEND_API_KEY')

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
      'Content-Profile': 'noodle', 'Accept-Profile': 'noodle',
    },
    body: JSON.stringify(args),
  })
  const body = await r.text()
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${body.slice(0, 200)}`)
  return body ? JSON.parse(body) : null
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405)
  const secret = req.headers.get('x-noodle-hook')
  if (!secret) return json({ error: 'unauthorized' }, 401)
  let input: { order_id?: string; event?: string }
  try { input = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  if (!input.order_id || !['placed', 'confirmed'].includes(input.event || '')) return json({ error: 'bad input' }, 400)

  let payload
  try { payload = await rpc('order_email_payload', { p_order: input.order_id, p_secret: secret }) }
  catch (e) { return json({ error: 'unauthorized or not found' }, 401) }
  if (!payload) return json({ error: 'order not found' }, 404)

  const mails = buildEmails(payload, input.event!)
  const s = payload.settings || {}
  const results = []
  for (const m of mails) {
    let status = 'sent', detail = ''
    if (!RESEND) { status = 'failed'; detail = 'RESEND_API_KEY is not set' }
    else {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: s.email_from || 'rendeles@101bistro.hu', to: m.to,
            reply_to: s.email_reply_to || undefined,
            subject: m.subject, html: m.html, text: m.text,
          }),
        })
        const body = await r.text()
        if (!r.ok) { status = 'failed'; detail = `${r.status} ${body}` } else detail = body
      } catch (e) { status = 'failed'; detail = String(e) }
    }
    try { await rpc('log_email', { p_secret: secret, p_order: input.order_id, p_kind: m.kind,
                                   p_recipient: m.to.join(', '), p_status: status, p_detail: detail }) } catch { /* ignore */ }
    results.push({ kind: m.kind, to: m.to, status })
  }
  return json({ ok: true, results })
})
