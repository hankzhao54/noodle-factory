// noodle-order-email: called by the orders trigger (pg_net) when an order is placed, confirmed or cancelled,
// by notify_order_change() when an order is changed / split (Slack only), and by slack_test() for the admin test button.
// Auth: the trigger sends a shared secret (x-noodle-hook) that the database checks in order_email_payload().
// Secrets: RESEND_API_KEY (emails), SLACK_WEBHOOK_URL (Slack channel), set in Supabase → Edge Functions → Secrets.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { buildEmails } from './email.ts'
import { buildSlack, buildPoSlack, slackTest } from './slack.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND = Deno.env.get('RESEND_API_KEY')
const SLACK = Deno.env.get('SLACK_WEBHOOK_URL')   // Incoming Webhook URL of the Slack channel
// purchase orders for suppliers ordered via Slack go to their own channel (e.g. #central-kitchen-team) when set
const SLACK_PO = Deno.env.get('SLACK_WEBHOOK_PURCHASE') || SLACK

async function postSlack(msg: { text: string }, url = SLACK) {
  if (!url) return { status: 'failed', detail: 'SLACK_WEBHOOK_URL is not set' }
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...msg, unfurl_links: false }) })
    const body = await r.text()
    return r.ok ? { status: 'sent', detail: body } : { status: 'failed', detail: `${r.status} ${body}` }
  } catch (e) { return { status: 'failed', detail: String(e) } }
}

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
  let input: { order_id?: string; po_id?: string; event?: string; detail?: string }
  try { input = await req.json() } catch { return json({ error: 'bad json' }, 400) }

  // admin "send test" button: no order
  if (input.event === 'slack_test') {
    let settings
    try { settings = await rpc('notify_settings', { p_secret: secret }) } catch { return json({ error: 'unauthorized' }, 401) }
    const r = await postSlack(slackTest(settings))
    try { await rpc('log_email', { p_secret: secret, p_order: null, p_kind: 'slack', p_recipient: 'Slack',
                                   p_status: r.status, p_detail: r.detail }) } catch { /* ignore */ }
    return json({ ok: true, slack: r.status })
  }
  // purchase order for a supplier ordered via Slack
  if (input.event === 'purchase' && input.po_id) {
    let payload
    try { payload = await rpc('po_slack_payload', { p_po: input.po_id, p_secret: secret }) } catch { return json({ error: 'unauthorized or not found' }, 401) }
    if (!payload) return json({ error: 'not found' }, 404)
    if ((payload.settings || {}).slack_mode !== 'on') return json({ ok: true, slack: 'off' })
    const r = await postSlack(buildPoSlack(payload), SLACK_PO)
    try { await rpc('log_email', { p_secret: secret, p_order: null, p_kind: 'slack_po', p_recipient: 'Slack: ' + (payload.supplier?.name || ''),
                                   p_status: r.status, p_detail: r.detail }) } catch { /* ignore */ }
    return json({ ok: true, slack: r.status })
  }
  if (!input.order_id || !['placed', 'confirmed', 'cancelled', 'changed'].includes(input.event || '')) return json({ error: 'bad input' }, 400)

  let payload
  try { payload = await rpc('order_email_payload', { p_order: input.order_id, p_secret: secret }) }
  catch (e) { return json({ error: 'unauthorized or not found' }, 401) }
  if (!payload) return json({ error: 'order not found' }, 404)

  const s = payload.settings || {}
  const results: unknown[] = []

  // Slack: new orders and cancellations
  if (s.slack_mode === 'on' && ['placed', 'cancelled', 'changed'].includes(input.event!)) {
    const r = await postSlack(buildSlack(payload, input.event!, String(input.detail || '').slice(0, 1500)))
    try { await rpc('log_email', { p_secret: secret, p_order: input.order_id, p_kind: 'slack', p_recipient: 'Slack',
                                   p_status: r.status, p_detail: r.detail }) } catch { /* ignore */ }
    results.push({ kind: 'slack', status: r.status })
  }

  const mails = ['cancelled', 'changed'].includes(input.event!) ? [] : buildEmails(payload, input.event!)
  for (const m of mails) {
    let status = 'sent', detail = ''
    if (!RESEND) { status = 'failed'; detail = 'RESEND_API_KEY is not set' }
    else {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: s.email_from || 'noodle@101bistro.hu', to: m.to,
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
