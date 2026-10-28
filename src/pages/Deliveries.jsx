import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate, fmtFt } from '../lib/i18n'
import { compressImage } from '../lib/image'
import { Modal, Field, Loading, ErrorBox, PageHead, Status, NumInput, useToast, errText } from '../components/ui'

export const PROOF_BUCKET = 'noodle-delivery-proofs'
const OPEN = ['submitted', 'confirmed', 'ready']

export default function Deliveries() {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(todayISO())
  const [modal, setModal] = useState(null)      // {kind, ...}
  const [printList, setPrintList] = useState(null)
  const { data, loading, error, reload } = useData(async () => {
    const [runs, orders, customers, products, stock] = await Promise.all([
      q(db.from('deliveries').select('*').eq('delivery_date', date).order('created_at')),
      q(db.from('orders').select('*, order_lines(*)').eq('delivery_date', date).neq('status', 'cancelled').order('created_at')),
      q(db.from('customers').select('*').order('name')),
      q(db.from('products').select('id,code,name_zh,name_en,name_hu,unit,base_price,active,sort').order('sort')),
      q(db.from('product_stock').select('id,on_hand,reserved')),
    ])
    return { runs, orders, customers, products, stock }
  }, [date])

  useEffect(() => {
    if (!printList) return
    const id = setTimeout(() => { window.print(); setPrintList(null) }, 60)
    return () => clearTimeout(id)
  }, [printList])

  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>

  const cust = id => data.customers.find(c => c.id === id) || {}
  const prod = id => data.products.find(p => p.id === id) || {}
  const run = id => data.runs.find(r => r.id === id)
  const groups = [
    { run: null, orders: data.orders.filter(o => !o.delivery_id || !run(o.delivery_id)) },
    ...data.runs.map(r => ({ run: r, orders: data.orders.filter(o => o.delivery_id === r.id) })),
  ].filter(g => g.run || g.orders.length)
  const done = data.orders.filter(o => o.status === 'delivered').length
  const ctx = { data, cust, prod, reload, setModal, print: list => setPrintList(list) }

  async function assign(order, runId) {
    try { await q(db.from('orders').update({ delivery_id: runId || null }).eq('id', order.id)); reload() }
    catch (e) { toast(errText(e), 'error') }
  }

  return (
    <div className="page">
      <PageHead title={t('nav_deliveries')}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label={t('date')} />
        <button className="btn" onClick={() => setModal({ kind: 'run' })}>{t('newRun')}</button>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>{t('newDeliveryForCustomer')}</button>
      </PageHead>

      {data.orders.length > 0 && (
        <p className="day-summary">
          <b>{fmtDate(date, t.lang)}</b>
          <span>{t('deliveredOf', { a: done, b: data.orders.length })}</span>
          <button className="btn btn-sm" onClick={() => setPrintList(data.orders)}>{t('printAll')}</button>
        </p>
      )}

      {data.orders.length === 0 && data.runs.length === 0 ? (
        <div className="empty">
          <p>{t('emptyDeliveries')}</p>
          <button className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>{t('newDeliveryForCustomer')}</button>
        </div>
      ) : groups.map(g => (
        <section key={g.run?.id || 'none'} className="run-group">
          <RunHeader run={g.run} orders={g.orders} ctx={ctx} />
          {g.orders.length === 0 ? <p className="muted pad-sm">{t('runEmpty')}</p> : (
            <div className="stop-grid">
              {g.orders.map(o => (
                <StopCard key={o.id} order={o} ctx={ctx} runs={data.runs} onAssign={assign} />
              ))}
            </div>
          )}
        </section>
      ))}

      {modal?.kind === 'new' && <NewDelivery date={date} ctx={ctx} onClose={() => setModal(null)} />}
      {modal?.kind === 'run' && <RunForm date={date} run={modal.run} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />}
      {modal?.kind === 'deliver' && <DeliverDialog order={modal.order} ctx={ctx} onClose={() => setModal(null)} />}

      {printList && createPortal(
        <div className="print-only">
          {printList.map(o => <DeliveryNote key={o.id} order={o} customer={cust(o.customer_id)} prod={prod} run={run(o.delivery_id)} />)}
        </div>, document.body)}
    </div>
  )
}

/* ---------------- run header (driver, loading list) ---------------- */
function RunHeader({ run, orders, ctx }) {
  const t = useT()
  const toast = useToast()
  const load = {}
  orders.filter(o => OPEN.includes(o.status)).forEach(o => o.order_lines.forEach(l => {
    load[l.product_id] = (load[l.product_id] || 0) + Number(l.qty)
  }))
  const open = orders.filter(o => OPEN.includes(o.status)).length
  const act = async (p, msg) => { try { await q(p); if (msg) toast(msg); ctx.reload() } catch (e) { toast(errText(e), 'error') } }

  if (!run) return (
    <div className="run-head">
      <h2>{t('noRun')}</h2>
      <span className="muted">{orders.length} {t('stops')}</span>
    </div>
  )
  return (
    <div className="run-head">
      <h2>{t('run')} D{run.no}</h2>
      <span className="run-who">{run.driver || '–'}{run.vehicle ? ` · ${run.vehicle}` : ''}</span>
      <Status value={run.status} prefix="d" />
      <span className="grow" />
      <button className="btn btn-sm btn-quiet" onClick={() => ctx.setModal({ kind: 'run', run })}>{t('edit')}</button>
      {orders.length > 0 && <button className="btn btn-sm" onClick={() => ctx.print(orders)}>{t('printAll')}</button>}
      {run.status === 'planned' && open > 0 &&
        <button className="btn btn-sm" onClick={() => act(db.from('deliveries').update({ status: 'out' }).eq('id', run.id))}>{t('depart')}</button>}
      {Object.keys(load).length > 0 && (
        <div className="load-list">
          <span className="muted small">{t('loadList')}</span>
          {Object.entries(load).map(([pid, qty]) => (
            <span key={pid} className="load-chip"><b>{fmtNum(qty, t.lang)}</b> {ctx.prod(pid).unit} {t.pick(ctx.prod(pid))}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- one delivery stop ---------------- */
function StopCard({ order: o, ctx, runs, onAssign }) {
  const t = useT()
  const c = ctx.cust(o.customer_id)
  const delivered = o.status === 'delivered'
  const internal = c.type === 'internal'
  const total = o.order_lines.reduce((s, l) => s + Number(delivered ? l.delivered_qty ?? l.qty : l.qty) * Number(l.unit_price || 0), 0)
  const stockOf = pid => ctx.data.stock.find(s => s.id === pid)

  return (
    <article className={`stop-card ${delivered ? 'is-done' : ''}`}>
      <header className="stop-head">
        <span className="mono-num">#{o.no}</span>
        <h3>{c.name}</h3>
        <span className={`tag tag-${c.type}`}>{t(c.type)}</span>
        <span className="grow" />
        <Status value={o.status} prefix="o" />
      </header>

      <dl className="cust-info">
        {c.address && <div><dt>{t('address')}</dt><dd>
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`} target="_blank" rel="noreferrer">{c.address}</a>
        </dd></div>}
        {(c.contact_person || c.phone) && <div><dt>{t('contact')}</dt><dd>
          {c.contact_person}{c.contact_person && c.phone ? ' · ' : ''}
          {c.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a>}
        </dd></div>}
        {c.delivery_notes && <div><dt>{t('deliveryNotes')}</dt><dd className="note-inline">{c.delivery_notes}</dd></div>}
        {o.notes && <div><dt>{t('notes')}</dt><dd className="note-inline">{o.notes}</dd></div>}
      </dl>

      <table className="stop-items">
        <tbody>{o.order_lines.map(l => {
          const p = ctx.prod(l.product_id)
          const s = stockOf(l.product_id)
          const short = !delivered && s && Number(s.on_hand) < Number(l.qty)
          return (
            <tr key={l.id}>
              <td>{t.pick(p)}</td>
              <td className="num">
                {delivered && l.delivered_qty != null && Number(l.delivered_qty) !== Number(l.qty)
                  ? <><s className="muted">{fmtNum(l.qty, t.lang)}</s> <b>{fmtNum(l.delivered_qty, t.lang)}</b></>
                  : <b>{fmtNum(l.qty, t.lang)}</b>}
                <span className="unit">{p.unit}</span>
              </td>
              {short && <td><span className="tag tag-low" title={t('inStock') + ': ' + fmtNum(s.on_hand, t.lang)}>{t('notEnoughStock')}</span></td>}
            </tr>
          )
        })}</tbody>
      </table>
      {!internal && total > 0 && <p className="stop-total">{t('total')}: <b>{fmtFt(total, t.lang)}</b></p>}

      {delivered && <ProofBlock order={o} ctx={ctx} />}

      <footer className="stop-foot">
        {!delivered && (
          <select value={o.delivery_id || ''} onChange={e => onAssign(o, e.target.value)} aria-label={t('run')} className="run-select">
            <option value="">{t('noRun')}</option>
            {runs.map(r => <option key={r.id} value={r.id}>D{r.no} {r.driver || ''}</option>)}
          </select>
        )}
        <span className="grow" />
        <button className="btn btn-sm" onClick={() => ctx.print([o])}>{t('printNote')}</button>
        {!delivered && <button className="btn btn-sm btn-primary" onClick={() => ctx.setModal({ kind: 'deliver', order: o })}>{t('confirmDelivered')}</button>}
      </footer>
    </article>
  )
}

/* ---------------- proof photos on a delivered stop ---------------- */
function ProofBlock({ order, ctx }) {
  const t = useT()
  const toast = useToast()
  const [urls, setUrls] = useState([])
  const [busy, setBusy] = useState(false)
  const paths = order.proof_paths || []

  useEffect(() => {
    let live = true
    if (!paths.length) { setUrls([]); return }
    const bucket = supabase.storage.from(PROOF_BUCKET)
    Promise.all([
      bucket.createSignedUrls(paths, 3600),
      bucket.createSignedUrls(paths, 3600, { download: true }),
    ]).then(([view, dl]) => {
      if (!live) return
      setUrls((view.data || []).map((d, i) => ({ view: d.signedUrl, download: dl.data?.[i]?.signedUrl })).filter(u => u.view))
    })
    return () => { live = false }
  }, [paths.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  async function addPhotos(files) {
    if (!files.length) return
    setBusy(true)
    try {
      const uploaded = await uploadProofs(order.id, files)
      await q(db.rpc('add_delivery_proofs', { p_order_id: order.id, p_proofs: uploaded }))
      toast(t('saved')); ctx.reload()
    } catch (e) { toast(t('photoFailed') + ' ' + errText(e), 'error') } finally { setBusy(false) }
  }

  return (
    <div className="proof-block">
      <p className="small">
        {order.received_by && <>{t('receivedBy')}: <b>{order.received_by}</b> · </>}
        {order.delivered_at && <span className="muted">{new Date(order.delivered_at).toLocaleString(t.lang === 'zh' ? 'zh-CN' : t.lang === 'en' ? 'en-GB' : 'hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
      </p>
      <div className="thumbs">
        {urls.map((u, i) => (
          <span key={i} className="thumb-item">
            <a href={u.view} target="_blank" rel="noreferrer"><img src={u.view} alt={`${t('proofPhotos')} ${i + 1}`} /></a>
            {u.download && <a className="thumb-dl" href={u.download}>{t('download')}</a>}
          </span>
        ))}
        <label className={`thumb-add ${busy ? 'is-busy' : ''}`}>
          <input type="file" accept="image/*" capture="environment" multiple hidden disabled={busy}
            onChange={e => { addPhotos([...e.target.files]); e.target.value = '' }} />
          {busy ? t('uploading') : (paths.length ? t('addMorePhotos') : t('addPhotos'))}
        </label>
      </div>
    </div>
  )
}

async function uploadProofs(orderId, files) {
  const out = []
  for (let i = 0; i < files.length; i++) {
    const { blob, ext, type } = await compressImage(files[i])
    const path = `${orderId}/${Date.now()}-${i}.${ext}`
    const { error } = await supabase.storage.from(PROOF_BUCKET).upload(path, blob, { contentType: type, upsert: false })
    if (error) throw error
    out.push(path)
  }
  return out
}

/* ---------------- confirm delivery: actual qty, receiver, photos ---------------- */
function DeliverDialog({ order: o, ctx, onClose }) {
  const t = useT()
  const toast = useToast()
  const c = ctx.cust(o.customer_id)
  const [qty, setQty] = useState(() => Object.fromEntries(o.order_lines.map(l => [l.id, Number(l.qty)])))
  const [receiver, setReceiver] = useState(c.contact_person || '')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const previews = useMemo(() => files.map(f => URL.createObjectURL(f)), [files])
  useEffect(() => () => previews.forEach(URL.revokeObjectURL), [previews])

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const proofs = files.length ? await uploadProofs(o.id, files) : []
      await q(db.rpc('deliver_order', {
        p_order_id: o.id,
        p_lines: o.order_lines.map(l => ({ line_id: l.id, qty: qty[l.id] ?? 0 })),
        p_received_by: receiver || null,
        p_proofs: proofs,
      }))
      toast(t('deliveredDone')); onClose(); ctx.reload()
    } catch (err) {
      toast((files.length ? t('photoFailed') + ' ' : '') + errText(err), 'error'); setBusy(false)
    }
  }

  return (
    <Modal title={`${t('confirmDelivered')} · #${o.no} ${c.name}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <table className="table compact">
          <thead><tr><th>{t('name')}</th><th className="num">{t('qty')}</th><th className="num">{t('deliveredQty')}</th></tr></thead>
          <tbody>{o.order_lines.map(l => {
            const p = ctx.prod(l.product_id)
            return (
              <tr key={l.id}>
                <td>{t.pick(p)}</td>
                <td className="num muted">{fmtNum(l.qty, t.lang)} {p.unit}</td>
                <td className="num"><NumInput className="input-sm" min={0} value={qty[l.id]} aria-label={`${t.pick(p)} ${t('deliveredQty')}`}
                  onChange={v => setQty(s => ({ ...s, [l.id]: v }))} /></td>
              </tr>
            )
          })}</tbody>
        </table>
        <p className="muted small">{t('stockDeductNote')}</p>
        <Field label={t('receivedBy')}><input value={receiver} onChange={e => setReceiver(e.target.value)} /></Field>
        <div className="field">
          <span className="field-label">{t('proofPhotos')}</span>
          <span className="field-hint">{t('proofInternalNote')}</span>
          <div className="thumbs">
            {previews.map((u, i) => (
              <span key={u} className="thumb-preview">
                <img src={u} alt="" />
                <button type="button" className="thumb-x" aria-label={t('delete')} onClick={() => setFiles(f => f.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            <label className="thumb-add">
              <input type="file" accept="image/*" capture="environment" multiple hidden
                onChange={e => { const picked = [...e.target.files]; setFiles(f => [...f, ...picked]); e.target.value = '' }} />
              {t('addPhotos')}
            </label>
          </div>
        </div>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? t('uploading') : t('confirmDelivered')}</button>
        </div>
      </form>
    </Modal>
  )
}

/* ---------------- new delivery for a customer ---------------- */
function NewDelivery({ date, ctx, onClose }) {
  const t = useT()
  const toast = useToast()
  const [customerId, setCustomerId] = useState('')
  const [deliveryDate, setDeliveryDate] = useState(date < todayISO() ? todayISO() : date)
  const [runId, setRunId] = useState('')
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState({})
  const [busy, setBusy] = useState(false)
  const c = ctx.data.customers.find(x => x.id === customerId)
  const { data: prices } = useData(() => customerId
    ? q(db.from('customer_prices').select('product_id,price').eq('customer_id', customerId)) : Promise.resolve([]), [customerId])
  const { data: runs } = useData(() => q(db.from('deliveries').select('*').eq('delivery_date', deliveryDate).neq('status', 'done').order('created_at')), [deliveryDate])

  const items = ctx.data.products.filter(p => p.active).map(p => {
    const s = ctx.data.stock.find(x => x.id === p.id) || { on_hand: 0, reserved: 0 }
    return { ...p, available: Number(s.on_hand) - Number(s.reserved),
             price: prices?.find(x => x.product_id === p.id)?.price ?? p.base_price }
  })
  const chosen = Object.entries(qty).filter(([, v]) => v > 0)
  const total = chosen.reduce((s, [pid, v]) => s + v * Number(items.find(i => i.id === pid)?.price || 0), 0)

  async function save() {
    setBusy(true)
    try {
      const id = await q(db.rpc('place_order', {
        p_delivery_date: deliveryDate, p_notes: notes || null, p_customer_id: customerId,
        p_lines: chosen.map(([product_id, v]) => ({ product_id, qty: v })),
      }))
      if (runId) await q(db.from('orders').update({ delivery_id: runId }).eq('id', id))
      toast(t('deliveryCreated')); onClose(); ctx.reload()
    } catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }

  return (
    <Modal wide title={t('newDeliveryForCustomer')} onClose={onClose}>
      <div className="form-grid">
        <Field label={t('customer')}>
          <select value={customerId} onChange={e => setCustomerId(e.target.value)} required>
            <option value="">{t('pickCustomer')}…</option>
            {ctx.data.customers.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label={t('deliveryDate')}><input type="date" min={todayISO()} value={deliveryDate} onChange={e => { setDeliveryDate(e.target.value); setRunId('') }} /></Field>
      </div>

      {c && (
        <dl className="cust-info cust-panel">
          <div><dt>{t('ctype')}</dt><dd><span className={`tag tag-${c.type}`}>{t(c.type)}</span></dd></div>
          <div><dt>{t('address')}</dt><dd>{c.address || '–'}</dd></div>
          <div><dt>{t('contact')}</dt><dd>{[c.contact_person, c.phone].filter(Boolean).join(' · ') || '–'}</dd></div>
          {c.email && <div><dt>{t('email')}</dt><dd>{c.email}</dd></div>}
          {c.vat_no && <div><dt>{t('vatNo')}</dt><dd>{c.vat_no}</dd></div>}
          {c.delivery_notes && <div><dt>{t('deliveryNotes')}</dt><dd className="note-inline">{c.delivery_notes}</dd></div>}
        </dl>
      )}

      {c && (
        <div className="table-wrap"><table className="table compact">
          <thead><tr><th>{t('name')}</th><th className="num">{t('available')}</th>
            {c.type !== 'internal' && <th className="num">{t('price')}</th>}
            <th className="num">{t('qty')}</th></tr></thead>
          <tbody>{items.map(p => {
            const v = qty[p.id]
            const over = v > 0 && v > p.available
            return (
              <tr key={p.id} className={v > 0 ? 'row-todo' : ''}>
                <td><b>{t.pick(p)}</b></td>
                <td className={`num ${p.available <= 0 ? 'neg' : 'muted'}`}>{fmtNum(p.available, t.lang)} <span className="unit">{p.unit}</span></td>
                {c.type !== 'internal' && <td className="num muted">{fmtFt(p.price, t.lang)}</td>}
                <td className="num">
                  <NumInput className={`input-sm ${over ? 'is-missing' : ''}`} min={0} value={v} placeholder="0"
                    aria-label={`${t.pick(p)} ${t('qty')}`} onChange={x => setQty(s => ({ ...s, [p.id]: x }))} />
                  {over && <div className="neg small">{t('notEnoughStock')}</div>}
                </td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}

      {c && <div className="form-grid" style={{ marginTop: 16 }}>
        <Field label={t('run')}>
          <select value={runId} onChange={e => setRunId(e.target.value)}>
            <option value="">{t('noRun')}</option>
            {(runs || []).map(r => <option key={r.id} value={r.id}>D{r.no} {r.driver || ''} {r.vehicle || ''}</option>)}
          </select>
        </Field>
        <Field label={t('notes')}><input value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      </div>}

      <div className="modal-foot">
        {c && c.type !== 'internal' && <b>{t('total')}: {fmtFt(total, t.lang)}</b>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={!c || !chosen.length || busy} onClick={save}>{t('scheduleDelivery')}</button>
      </div>
    </Modal>
  )
}

/* ---------------- delivery run (driver / vehicle) ---------------- */
function RunForm({ date, run, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [v, setV] = useState({ delivery_date: run?.delivery_date || date, driver: run?.driver || '', vehicle: run?.vehicle || '', notes: run?.notes || '' })
  async function save(e) {
    e.preventDefault()
    try {
      if (run) await q(db.from('deliveries').update(v).eq('id', run.id))
      else await q(db.from('deliveries').insert(v))
      onDone()
    } catch (err) { toast(errText(err), 'error') }
  }
  async function remove() {
    if (!confirm(t('confirmDelete'))) return
    try {
      await q(db.from('orders').update({ delivery_id: null }).eq('delivery_id', run.id).neq('status', 'delivered'))
      await q(db.from('deliveries').delete().eq('id', run.id)); onDone()
    } catch (err) { toast(errText(err), 'error') }
  }
  return (
    <Modal title={run ? `${t('run')} D${run.no}` : t('newRun')} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <p className="muted small">{t('runHint')}</p>
        <Field label={t('date')}><input type="date" value={v.delivery_date} onChange={e => setV({ ...v, delivery_date: e.target.value })} /></Field>
        <Field label={t('driver')}><input value={v.driver} onChange={e => setV({ ...v, driver: e.target.value })} /></Field>
        <Field label={t('vehicle')}><input value={v.vehicle} onChange={e => setV({ ...v, vehicle: e.target.value })} /></Field>
        <Field label={t('notes')}><input value={v.notes} onChange={e => setV({ ...v, notes: e.target.value })} /></Field>
        <div className="modal-foot">
          {run && run.status !== 'done' && <button type="button" className="btn btn-danger-quiet" onClick={remove}>{t('delete')}</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('save')}</button></div>
      </form>
    </Modal>
  )
}

/* ---------------- printable delivery note ---------------- */
function DeliveryNote({ order: o, customer: c, prod, run }) {
  const t = useT()
  const internal = c.type === 'internal'
  const delivered = o.status === 'delivered'
  const qtyOf = l => Number(delivered && l.delivered_qty != null ? l.delivered_qty : l.qty)
  const total = o.order_lines.reduce((s, l) => s + qtyOf(l) * Number(l.unit_price || 0), 0)
  return (
    <article className="dnote">
      <header>
        <div>
          <h1>{t('deliveryNote')}</h1>
          <p>{t('appName')}</p>
        </div>
        <div className="dnote-meta">
          <p><b>#{o.no}</b></p>
          <p>{fmtDate(o.delivery_date, t.lang)}</p>
          {run && <p>D{run.no} {run.driver || ''} {run.vehicle || ''}</p>}
        </div>
      </header>
      <section className="dnote-to">
        <p className="dnote-label">{t('customer')}</p>
        <p><b>{c.name}</b></p>
        {c.address && <p>{c.address}</p>}
        {(c.contact_person || c.phone) && <p>{[c.contact_person, c.phone].filter(Boolean).join(' · ')}</p>}
        {c.vat_no && <p>{t('vatNo')}: {c.vat_no}</p>}
      </section>
      <table>
        <thead><tr><th>{t('name')}</th><th className="r">{t('qty')}</th>{!internal && <><th className="r">{t('price')}</th><th className="r">{t('total')}</th></>}</tr></thead>
        <tbody>{o.order_lines.map(l => {
          const p = prod(l.product_id)
          return (
            <tr key={l.id}>
              <td>{t.pick(p)}{p.code ? ` (${p.code})` : ''}</td>
              <td className="r">{fmtNum(qtyOf(l), t.lang)} {p.unit}</td>
              {!internal && <><td className="r">{fmtFt(l.unit_price, t.lang)}</td><td className="r">{fmtFt(qtyOf(l) * l.unit_price, t.lang)}</td></>}
            </tr>
          )
        })}</tbody>
        {!internal && <tfoot><tr><td colSpan={3}>{t('total')}</td><td className="r">{fmtFt(total, t.lang)}</td></tr></tfoot>}
      </table>
      {(c.delivery_notes || o.notes) && <p className="dnote-notes">{[c.delivery_notes, o.notes].filter(Boolean).join(' · ')}</p>}
      <div className="dnote-sign">
        <div><span>{t('issuedBy')}</span></div>
        <div><span>{t('signature')}{o.received_by ? `: ${o.received_by}` : ''}</span></div>
      </div>
    </article>
  )
}
