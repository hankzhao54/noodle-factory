import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate, fmtFt, translate, pickName } from '../lib/i18n'
import { compressImage } from '../lib/image'
import { usePublicInfo } from '../lib/publicInfo'
import { packFees, packText, packTextHu, lineFee, hasPacking, lineBags } from '../lib/packing'
import { allergenName, drawSimpleLabel, labelFontsReady, readPaper, LABEL_SIZES } from '../components/LabelPrint'
import { isTouch, shareCanvases, pdfFromCanvases, deliverPdf } from '../lib/labelOutput'
import { Modal, Field, Loading, ErrorBox, PageHead, Status, NumInput, useToast, errText } from '../components/ui'

export const PROOF_BUCKET = 'noodle-delivery-proofs'
const OPEN = ['submitted', 'confirmed', 'ready']

export default function Deliveries() {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(() => new URLSearchParams(window.location.search).get('date') || todayISO())
  const [modal, setModal] = useState(null)      // {kind, ...}
  const [printList, setPrintList] = useState(null)
  // company details for the notes: load them now, not when printing starts (they would arrive too late)
  const info = usePublicInfo()
  const { data, loading, error, reload } = useData(async () => {
    const [runs, orders, customers, products, stock, pinfo, earlier] = await Promise.all([
      q(db.from('deliveries').select('*').eq('delivery_date', date).order('created_at')),
      q(db.from('orders').select('*, order_lines(*), store:customer_locations(name,address,contact_person,phone,notes)').eq('delivery_date', date).neq('status', 'cancelled').order('created_at')),
      q(db.from('customers').select('*').order('name')),
      q(db.from('products').select('id,code,name_zh,name_en,name_hu,unit,base_price,active,sort').order('sort')),
      q(db.from('product_stock').select('id,on_hand,reserved')),
      q(db.rpc('product_info')).catch(() => ({})),
      // not yet delivered orders of earlier days still need the same stock
      q(db.from('orders').select('order_lines(product_id,qty)').lt('delivery_date', date).in('status', OPEN)),
    ])
    return { runs, orders, customers, products, stock, pinfo: pinfo || {}, earlier }
  }, [date])

  useEffect(() => {
    if (!printList) return
    const id = setTimeout(() => { window.print(); setPrintList(null) }, 60)
    return () => clearTimeout(id)
  }, [printList])

  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>

  const cust = id => data.customers.find(c => c.id === id) || {}
  // where an order goes: the store (if the order is for one of the company's stores), else the company
  const shipTo = o => {
    const c = cust(o.customer_id), l = o.store
    if (!l) return c
    return { ...c, name: `${c.name} · ${l.name}`, address: l.address || c.address,
      contact_person: l.contact_person || c.contact_person, phone: l.phone || c.phone, delivery_notes: l.notes || c.delivery_notes }
  }
  const prod = id => data.products.find(p => p.id === id) || {}
  const run = id => data.runs.find(r => r.id === id)
  const groups = [
    { run: null, orders: data.orders.filter(o => !o.delivery_id || !run(o.delivery_id)) },
    ...data.runs.map(r => ({ run: r, orders: data.orders.filter(o => o.delivery_id === r.id) })),
  ].filter(g => g.run || g.orders.length)
  // not yet delivered on top, delivered (and cancelled) at the bottom; otherwise keep the order
  const rank = o => (o.status === 'delivered' || o.status === 'cancelled' ? 1 : 0)
  for (const g of groups) g.orders = g.orders.map((o, i) => [o, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0])
  const done = data.orders.filter(o => o.status === 'delivered').length
  // shipping label (label printer, same paper as all other labels): one per order
  async function printShipLabels(list) {
    if (!list.length) return
    try {
      await labelFontsReady()
      const paper = readPaper()
      const size = LABEL_SIZES.find(x => x.id === paper.size) || LABEL_SIZES[0]
      const w = size.custom ? (paper.cw || 62) : size.w
      const h = size.custom ? (paper.ch || 31.5) : size.cont ? (paper.length || 31.5) : size.h
      const cs = list.map(o => drawSimpleLabel({ w, h, margin: paper.margin, textLines: shipLabelLines(o, shipTo(o), prod, run(o.delivery_id)) }))
      const name = list.length === 1 ? `ship-${list[0].no}` : `ship-${date}`
      if (isTouch()) await shareCanvases(cs, name)
      else await deliverPdf(pdfFromCanvases(cs, w, h), name)
    } catch (e) { if (e?.name !== 'AbortError') toast(errText(e), 'error') }
  }
  const isInternal = o => cust(o.customer_id)?.type === 'internal'
  // stock check for the whole day: the stock is shared, so orders are served one after another
  // (earlier days' open orders first); a line is short when what is left does not cover it
  const left = Object.fromEntries(data.stock.map(s => [s.id, Number(s.on_hand)]))
  for (const o of data.earlier) for (const l of o.order_lines) left[l.product_id] = (left[l.product_id] ?? 0) - Number(l.qty)
  const dayNeed = {}, lineShort = {}
  // orders already marked ready have their goods set aside: they take stock first and never show a shortage
  const openToday = data.orders.filter(o => OPEN.includes(o.status))
  const byReady = [...openToday.filter(o => o.status === 'ready' || o.packed_at), ...openToday.filter(o => !(o.status === 'ready' || o.packed_at))]
  for (const o of byReady) for (const l of o.order_lines) {
    const have = left[l.product_id] ?? 0
    dayNeed[l.product_id] = (dayNeed[l.product_id] || 0) + Number(l.qty)
    const setAside = o.status === 'ready' || o.packed_at
    if (have < Number(l.qty) && !setAside) lineShort[l.id] = { have: Math.max(0, have), missing: Number(l.qty) - Math.max(0, have) }
    left[l.product_id] = have - Number(l.qty)
  }
  const dayShort = Object.keys(dayNeed).filter(pid => (left[pid] ?? 0) < -0.0005)
    .map(pid => ({ p: prod(pid), need: dayNeed[pid], missing: -left[pid] }))
  const ctx = { data, cust, shipTo, prod, reload, setModal, lineShort, printLabels: printShipLabels, print: list => {
    // every order gets a delivery note (own restaurants too, since Nov 2026)
    if (list.length) setPrintList(list)
  } }

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
          {data.orders.length > 0 && <button className="btn btn-sm" onClick={() => ctx.print(data.orders)}>{t('printAllNotes')}</button>}
          {data.orders.some(isInternal) && <button className="btn btn-sm" onClick={() => printShipLabels(data.orders.filter(isInternal))}>{t('printInternalLabels')}</button>}
        </p>
      )}
      {dayShort.length > 0 && (
        <p className="note-box short-box">⚠ {t('dayShort')}: {dayShort.map(x => `${t.pick(x.p)} ${t('need')} ${fmtNum(x.need, t.lang)} · ${t('shortBy')} ${fmtNum(Math.round(x.missing * 10) / 10, t.lang)} ${x.p.unit || 'kg'}`).join(' ； ')}</p>
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
      {modal?.kind === 'split' && <SplitDialog order={modal.order} ctx={ctx} onClose={() => setModal(null)} />}

      {printList && createPortal(
        <div className="print-only">
          {printList.map(o => <DeliveryNote key={o.id} order={o} customer={shipTo(o)} prod={prod} run={run(o.delivery_id)} pinfo={data.pinfo} info={info} />)}
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
      {orders.length > 0 && <button className="btn btn-sm" onClick={() => ctx.print(orders)}>{t('printAllNotes')}</button>}
      {orders.some(o => ctx.cust(o.customer_id)?.type === 'internal') && <button className="btn btn-sm" onClick={() => ctx.printLabels(orders.filter(o => ctx.cust(o.customer_id)?.type === 'internal'))}>{t('printInternalLabels')}</button>}
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
  const c = ctx.shipTo(o)
  const delivered = o.status === 'delivered'
  const internal = c.type === 'internal'
  const total = o.order_lines.reduce((s, l) => s + Number(delivered ? l.delivered_qty ?? l.qty : l.qty) * (Number(l.unit_price || 0) + lineFee(l)), 0)
  const fees = packFees(usePublicInfo()), bag = fees.bag
  const custRow = ctx.cust ? ctx.cust(o.customer_id) : null

  return (
    <article className={`stop-card ${delivered ? 'is-done' : ''}`}>
      <header className="stop-head">
        <span className="mono-num">#{o.no}</span>
        <h3>{c.name}</h3>
        <span className={`tag tag-${c.type}`}>{t(c.type)}</span>
        {o.urgent && <span className="tag tag-urgent">🚨 {t('urgent')}</span>}
        <span className="grow" />
        <Status value={o.status} prefix="o" />
      </header>
      {o.packed_at && !delivered && <PackRow order={o} ctx={ctx} />}

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
          const sh = !delivered && ctx.lineShort[l.id]
          return (
            <tr key={l.id}>
              <td>{t.pick(p)}{hasPacking(l) && <div className="pack-tag">📦 {packText(t, l, bag)}{lineBags(l, custRow, fees) > 0 && <b> · {t('bagsN', { n: lineBags(l, custRow, fees) })}</b>}</div>}</td>
              <td className="num">
                {delivered && l.delivered_qty != null && Number(l.delivered_qty) !== Number(l.qty)
                  ? <><s className="muted">{fmtNum(l.qty, t.lang)}</s> <b>{fmtNum(l.delivered_qty, t.lang)}</b></>
                  : <b>{fmtNum(l.qty, t.lang)}</b>}
                <span className="unit">{p.unit}</span>
              </td>
              {sh && <td><span className="tag tag-low" title={t('shortBy') + ': ' + fmtNum(Math.round(sh.missing * 10) / 10, t.lang)}>{t('notEnoughStock')} −{fmtNum(Math.round(sh.missing * 10) / 10, t.lang)}</span></td>}
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
        {internal && !delivered && <span className="muted small">{t('confirmInApp')}</span>}
        <button className="btn btn-sm" onClick={() => ctx.printLabels([o])}>{t('printShipLabel')}</button>
        <button className="btn btn-sm" onClick={() => ctx.print([o])}>{t('printNote')}</button>
        {!delivered && <button className="btn btn-sm" onClick={() => ctx.setModal({ kind: 'split', order: o })}>✂️ {t('splitLater')}</button>}
        {!delivered && !o.packed_at && <ReadyButton order={o} ctx={ctx} />}
        {!delivered && <button className="btn btn-sm btn-primary" onClick={() => ctx.setModal({ kind: 'deliver', order: o })}>{t('confirmDelivered')}</button>}
      </footer>
    </article>
  )
}

/* ---------------- "goods ready" record for an order ---------------- */
function useSetReady(o, ctx) {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function set(ready) {
    setBusy(true)
    try { await q(db.rpc('set_order_packed', { p_order: o.id, p_packed: ready })); toast(ready ? t('readyDone') : t('readyUndone')); ctx.reload() }
    catch (e) { toast(errText(e), 'error') }
    setBusy(false)
  }
  return [busy, set]
}
function ReadyButton({ order: o, ctx }) {
  const t = useT()
  const [busy, set] = useSetReady(o, ctx)
  return <button className="btn btn-sm" disabled={busy} onClick={() => set(true)}>✓ {t('markReadyBtn')}</button>
}
function PackRow({ order: o, ctx }) {
  const t = useT()
  const [busy, set] = useSetReady(o, ctx)
  return (
    <div className="pack-row is-packed">
      <span>✓ <b>{t('o_ready')}</b> · {new Date(o.packed_at).toLocaleString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{o.packed_by_name ? ` · ${o.packed_by_name}` : ''}</span>
      <span className="grow" />
      <button className="btn-link small" disabled={busy} onClick={() => set(false)}>{t('unpack')}</button>
    </div>
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
  const c = ctx.shipTo(o)
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

/* ---------------- split: deliver part now, the rest on a later day ---------------- */
function SplitDialog({ order: o, ctx, onClose }) {
  const t = useT()
  const toast = useToast()
  const c = ctx.shipTo(o)
  const stockOf = pid => ctx.data.stock.find(s => s.id === pid)
  // prefill: what the stock covers now, the rest later
  const [now, setNow] = useState(() => Object.fromEntries(o.order_lines.map(l => {
    const sh = ctx.lineShort[l.id]; const q0 = Number(l.qty)
    return [l.id, sh ? Math.max(0, Math.floor(sh.have * 10) / 10) : q0]
  })))
  const [date, setDate] = useState(todayISO(1) > o.delivery_date ? todayISO(1) : (() => {
    const d = new Date(o.delivery_date + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10)
  })())
  const [busy, setBusy] = useState(false)
  const later = l => Math.max(0, Number(l.qty) - Math.min(Number(now[l.id] ?? 0), Number(l.qty)))
  const anyLater = o.order_lines.some(l => later(l) > 0)
  const anyNow = o.order_lines.some(l => Number(now[l.id] ?? 0) > 0)

  async function submit(e) {
    e.preventDefault()
    if (!anyLater) return toast(t('splitNothing'), 'error')
    setBusy(true)
    try {
      // nothing goes out now: move the whole order to the later day
      if (!anyNow) {
        await q(db.rpc('change_order_date', { p_order: o.id, p_date: date }))
        toast(t('movedWhole')); onClose(); ctx.reload(); return
      }
      await q(db.rpc('split_order_qty', {
        p_order: o.id,
        p_items: o.order_lines.filter(l => later(l) > 0).map(l => ({ line_id: l.id, qty: later(l) })),
        p_delivery_date: date,
      }))
      toast(t('splitDone')); onClose(); ctx.reload()
    } catch (err) { toast(errText(err), 'error'); setBusy(false) }
  }

  return (
    <Modal title={`✂️ ${t('splitLater')} · #${o.no} ${c.name}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted small">{t('splitLaterHint')}</p>
        <table className="table compact">
          <thead><tr><th>{t('name')}</th><th className="num">{t('qty')}</th><th className="num">{t('inStock')}</th><th className="num">{t('deliverNow')}</th><th className="num">{t('deliverLater')}</th></tr></thead>
          <tbody>{o.order_lines.map(l => {
            const p = ctx.prod(l.product_id); const s = stockOf(l.product_id)
            const short = !!ctx.lineShort[l.id]
            return (
              <tr key={l.id}>
                <td>{t.pick(p)}</td>
                <td className="num muted">{fmtNum(l.qty, t.lang)} {p.unit}</td>
                <td className={'num' + (short ? ' text-short' : ' muted')}>{s ? fmtNum(s.on_hand, t.lang) : '–'}</td>
                <td className="num"><NumInput className="input-sm" min={0} max={Number(l.qty)} value={now[l.id]} aria-label={`${t.pick(p)} ${t('deliverNow')}`}
                  onChange={v => setNow(x => ({ ...x, [l.id]: v }))} /></td>
                <td className="num">{later(l) > 0 ? <b>{fmtNum(later(l), t.lang)}</b> : <span className="muted">–</span>}</td>
              </tr>
            )
          })}</tbody>
        </table>
        <Field label={t('deliverLaterOn')}><input type="date" required min={todayISO()} value={date} onChange={e => setDate(e.target.value)} /></Field>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={busy || !anyLater}>{anyNow ? `✂️ ${t('splitLaterBtn')}` : `📅 ${t('moveWholeBtn')}`}</button>
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
  const [storeId, setStoreId] = useState('')
  const { data: stores } = useData(() => customerId
    ? q(db.from('customer_locations').select('*').eq('customer_id', customerId).eq('active', true).order('sort').order('name'))
    : Promise.resolve([]), [customerId])
  const store = stores?.find(l => l.id === storeId)
  const [deliveryDate, setDeliveryDate] = useState(date < todayISO() ? todayISO() : date)
  const [runId, setRunId] = useState('')
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState({})
  const [busy, setBusy] = useState(false)
  const c = ctx.data.customers.find(x => x.id === customerId)
  const { data: prices } = useData(() => customerId
    ? q(db.rpc('prices_for_customer', { p_customer: customerId })) : Promise.resolve([]), [customerId])
  const { data: runs } = useData(() => q(db.from('deliveries').select('*').eq('delivery_date', deliveryDate).neq('status', 'done').order('created_at')), [deliveryDate])
  // orders this customer already has that are not delivered yet: deliver those instead of creating a new one
  const { data: openOrders } = useData(() => customerId
    ? q(db.from('orders').select('id,no,status,delivery_date,urgent,location_id,order_lines(product_id,qty)').eq('customer_id', customerId)
        .in('status', ['submitted', 'confirmed', 'ready']).order('delivery_date'))
    : Promise.resolve([]), [customerId])
  const existing = (openOrders || []).filter(o => !storeId || !o.location_id || o.location_id === storeId)
  async function attachExisting(o) {
    setBusy(true)
    try {
      if (o.delivery_date !== deliveryDate) await q(db.rpc('change_order_date', { p_order: o.id, p_date: deliveryDate }))
      if (o.status === 'submitted') await q(db.from('orders').update({ status: 'confirmed' }).eq('id', o.id))
      await q(db.from('orders').update({ delivery_id: runId || null }).eq('id', o.id))
      toast(t('existingOrderScheduled', { no: o.no })); onClose(); ctx.reload()
    } catch (e) { toast(errText(e), 'error'); setBusy(false) }
  }

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
        p_delivery_date: deliveryDate, p_notes: notes || null, p_customer_id: customerId, p_location_id: storeId || null,
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
          <select value={customerId} onChange={e => { setCustomerId(e.target.value); setStoreId('') }} required>
            <option value="">{t('pickCustomer')}…</option>
            {ctx.data.customers.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        {stores?.length > 0 && <Field label={t('store')}>
          <select value={storeId} onChange={e => setStoreId(e.target.value)} required className={!storeId ? 'is-missing' : ''}>
            <option value="">–</option>
            {stores.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></Field>}
        <Field label={t('deliveryDate')}><input type="date" min={todayISO()} value={deliveryDate} onChange={e => { setDeliveryDate(e.target.value); setRunId('') }} /></Field>
      </div>

      {c && (
        <dl className="cust-info cust-panel">
          <div><dt>{t('ctype')}</dt><dd><span className={`tag tag-${c.type}`}>{t(c.type)}</span></dd></div>
          <div><dt>{t('address')}</dt><dd>{store?.address || c.address || '–'}</dd></div>
          <div><dt>{t('contact')}</dt><dd>{[store?.contact_person || c.contact_person, store?.phone || c.phone].filter(Boolean).join(' · ') || '–'}</dd></div>
          {c.email && <div><dt>{t('email')}</dt><dd>{c.email}</dd></div>}
          {c.vat_no && <div><dt>{t('vatNo')}</dt><dd>{c.vat_no}</dd></div>}
          {c.delivery_notes && <div><dt>{t('deliveryNotes')}</dt><dd className="note-inline">{c.delivery_notes}</dd></div>}
        </dl>
      )}

      {c && existing.length > 0 && (
        <div className="note-box existing-orders">
          <p><b>{t('customerHasOpenOrders')}</b></p>
          {existing.map(o => (
            <div key={o.id} className="existing-order">
              <span>#{o.no} · {fmtDate(o.delivery_date, t.lang)}{o.urgent ? ' · 🚨' : ''} · {o.order_lines.map(l => {
                const p = ctx.prod(l.product_id); return `${t.pick(p)} ${fmtNum(l.qty, t.lang)} ${p.unit || ''}` }).join(', ')}</span>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => attachExisting(o)}>
                {o.delivery_date === deliveryDate ? t('scheduleThisOrder') : t('moveAndSchedule', { date: fmtDate(deliveryDate, t.lang) })}</button>
            </div>
          ))}
          <p className="muted small">{t('newOrderOnlyIfExtra')}</p>
        </div>
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
        <button className="btn btn-primary" disabled={!c || !chosen.length || busy || (stores?.length > 0 && !storeId)} onClick={save}>{t('scheduleDelivery')}</button>
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
// ingredients + allergens per product, always in Hungarian (food information for the buyer)
// under each product: allergens and storage (no ingredient list)
function ingrLine(pi) {
  const parts = []
  if (pi?.allergens?.length) parts.push(<span key="a"><span>Allergének: </span><b>{pi.allergens.map(a => allergenName(a, 'hu')).join(', ')}</b></span>)
  if (pi?.storage) parts.push(<span key="s"><span>Tárolás: </span>{pi.storage}</span>)
  if (!parts.length) return null
  return <p className="dnote-ingr">{parts.map((x, i) => <span key={i}>{i ? ' · ' : ''}{x}</span>)}</p>
}

// shipping label text (Hungarian, like the notes): who, which order / day / run, what
function shipLabelLines(o, c, prod, run) {
  const qtyOf = l => Number(o.status === 'delivered' && l.delivered_qty != null ? l.delivered_qty : l.qty)
  const num = v => Number(v).toLocaleString('hu-HU', { maximumFractionDigits: 2 })
  const d = new Date(o.delivery_date + 'T00:00:00').toLocaleDateString('hu-HU', { month: '2-digit', day: '2-digit', weekday: 'short' })
  const lines = [
    { text: c.name || '–', bold: true },
    { text: [`#${o.no}`, d, run ? `D${run.no}` : null].filter(Boolean).join(' · ') },
  ]
  const totals = {}
  o.order_lines.forEach(l => {
    const p = prod(l.product_id)
    lines.push({ text: `${p.name_hu || '–'}: ${num(qtyOf(l))} ${p.unit || ''}`, bold: true })
    if (hasPacking(l)) lines.push({ text: '  ' + packTextHu(l) })
    totals[p.unit || ''] = (totals[p.unit || ''] || 0) + qtyOf(l)
  })
  if (o.order_lines.length > 1) lines.push({ text: 'Összesen: ' + Object.entries(totals).map(([u, v]) => `${num(v)} ${u}`).join(' + ') })
  return lines
}

// delivery notes are always printed in Hungarian, whatever language the app is in
const huT = Object.assign((k, v) => translate('hu', k, v), { lang: 'hu', pick: row => pickName('hu', row) })
const huDate = d => new Date(d + 'T00:00:00').toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })

function DeliveryNote({ order: o, customer: c, prod, run, pinfo, info }) {
  const t = huT
  // prices are never shown on the delivery note (they belong on the invoice)
  const delivered = o.status === 'delivered'
  const qtyOf = l => Number(delivered && l.delivered_qty != null ? l.delivered_qty : l.qty)
  // total per unit (kg, darab …)
  const totals = {}
  o.order_lines.forEach(l => { const u = prod(l.product_id).unit || ''; totals[u] = (totals[u] || 0) + qtyOf(l) })
  const contact = [info?.company_phone, info?.company_email].filter(Boolean).join(' · ')
  return (
    <article className="dnote">
      <header className="dnote-head">
        <div className="dnote-from">
          <p className="dnote-company">{info?.company_name || t('appName')}</p>
          {info?.company_address && <p>{info.company_address}</p>}
          {(info?.company_tax_no || info?.company_reg_no) && <p>
            {info?.company_tax_no && <>{t('vatNo')}: {info.company_tax_no}</>}
            {info?.company_tax_no && info?.company_reg_no && ' · '}
            {info?.company_reg_no && <>Cg.: {info.company_reg_no}</>}
          </p>}
          {contact && <p>{contact}</p>}
        </div>
        <div className="dnote-title">
          <h1>{t('deliveryNote')}</h1>
          <p className="dnote-no">#{o.no}</p>
          <p>{huDate(o.delivery_date)}</p>
          {run && <p className="dnote-run">D{run.no}{run.driver ? ` · ${run.driver}` : ''}{run.vehicle ? ` · ${run.vehicle}` : ''}</p>}
        </div>
      </header>
      <section className="dnote-to">
        <p className="dnote-label">Vevő</p>
        <p className="dnote-cust">{c.name}</p>
        {c.address && <p>{c.address}</p>}
        {(c.contact_person || c.phone) && <p>{[c.contact_person, c.phone].filter(Boolean).join(' · ')}</p>}
        {c.vat_no && <p>{t('vatNo')}: {c.vat_no}</p>}
      </section>
      <table className="dnote-lines">
        <colgroup><col className="dnote-c-no" /><col /><col className="dnote-c-qty" /></colgroup>
        <thead><tr><th>#</th><th>Termék</th><th className="r">{t('qty')}</th></tr></thead>
        <tbody>{o.order_lines.map((l, i) => {
          const p = prod(l.product_id)
          return (
            <tr key={l.id}>
              <td className="dnote-i">{i + 1}</td>
              <td><span className="dnote-prod">{t.pick(p)}</span>{p.code && <span className="dnote-code"> {p.code}</span>}
                {hasPacking(l) && <span className="dnote-pack"> · {packTextHu(l, info?.packing_bag_text)}</span>}{ingrLine(pinfo?.[l.product_id])}</td>
              <td className="dnote-qty"><b>{fmtNum(qtyOf(l), t.lang)}</b> <span>{p.unit}</span></td>
            </tr>
          )
        })}</tbody>
        <tfoot><tr><td /><td className="r">{t('total')}</td>
          <td className="dnote-qty">{Object.entries(totals).map(([u, v]) => <div key={u}><b>{fmtNum(v, t.lang)}</b> <span>{u}</span></div>)}</td>
        </tr></tfoot>
      </table>
      {(c.delivery_notes || o.notes) && <p className="dnote-notes">{[c.delivery_notes, o.notes].filter(Boolean).join(' · ')}</p>}
      <div className="dnote-sign">
        <div><span>{t('issuedBy')}</span></div>
        <div><span>{t('signature')}{o.received_by ? `: ${o.received_by}` : ''}</span></div>
      </div>
    </article>
  )
}
