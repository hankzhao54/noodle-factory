import { useState } from 'react'
import { createPortal } from 'react-dom'
import { db, q, todayISO } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtDate, fmtFt } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, Status, useToast, errText } from '../components/ui'

export default function Deliveries() {
  const t = useT()
  const [date, setDate] = useState(todayISO())
  const [openRun, setOpenRun] = useState(null)
  const [creating, setCreating] = useState(false)
  const { data, loading, error, reload } = useData(async () => {
    const [runs, orders, customers, products] = await Promise.all([
      q(db.from('deliveries').select('*').eq('delivery_date', date).order('created_at')),
      q(db.from('orders').select('*, order_lines(*)').eq('delivery_date', date).neq('status', 'cancelled').order('created_at')),
      q(db.from('customers').select('*')),
      q(db.from('products').select('id,name_zh,name_en,name_hu,unit,sort').order('sort')),
    ])
    return { runs, orders, customers, products }
  }, [date])

  if (loading && !data) return <div className="page"><Loading /></div>
  if (!data) return <div className="page"><ErrorBox error={error} /></div>
  const unassigned = data.orders.filter(o => !o.delivery_id && o.status !== 'delivered')
  const run = openRun && data.runs.find(r => r.id === openRun)

  return (
    <div className="page">
      <PageHead title={t('nav_deliveries')}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label={t('date')} />
        <button className="btn btn-primary" onClick={() => setCreating(true)}>{t('newDelivery')}</button>
      </PageHead>

      {data.runs.length === 0 ? <Empty /> : (
        <div className="run-grid">
          {data.runs.map(r => {
            const stops = data.orders.filter(o => o.delivery_id === r.id)
            return (
              <button key={r.id} className="run-card" onClick={() => setOpenRun(r.id)}>
                <span className="run-no">D{r.no}</span>
                <span className="run-driver">{r.driver || '–'} {r.vehicle ? `· ${r.vehicle}` : ''}</span>
                <span className="run-stops">{stops.length} {t('stops')}</span>
                <Status value={r.status} prefix="d" />
              </button>
            )
          })}
        </div>
      )}

      <section className="panel">
        <div className="panel-head"><h2>{t('unassigned')}</h2><span className="muted">{unassigned.length}</span></div>
        {unassigned.length === 0 ? <p className="muted pad">{t('allGood')}</p> : (
          <ul className="stop-list">
            {unassigned.map(o => {
              const c = data.customers.find(x => x.id === o.customer_id) || {}
              return <li key={o.id}><b>#{o.no} {c.name}</b><span className="muted">{c.address}</span><Status value={o.status} prefix="o" /></li>
            })}
          </ul>
        )}
      </section>

      {creating && <NewRun date={date} onClose={() => setCreating(false)} onDone={id => { setCreating(false); reload(); setOpenRun(id) }} />}
      {run && <RunDetail run={run} data={data} unassigned={unassigned} onClose={() => setOpenRun(null)} reload={reload} />}
    </div>
  )
}

function NewRun({ date, onClose, onDone }) {
  const t = useT()
  const toast = useToast()
  const [v, setV] = useState({ delivery_date: date, driver: '', vehicle: '', notes: '' })
  async function save(e) {
    e.preventDefault()
    try { const r = await q(db.from('deliveries').insert(v).select().single()); onDone(r.id) }
    catch (err) { toast(errText(err), 'error') }
  }
  return (
    <Modal title={t('newDelivery')} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <Field label={t('date')}><input type="date" value={v.delivery_date} onChange={e => setV({ ...v, delivery_date: e.target.value })} /></Field>
        <Field label={t('driver')}><input value={v.driver} onChange={e => setV({ ...v, driver: e.target.value })} /></Field>
        <Field label={t('vehicle')}><input value={v.vehicle} onChange={e => setV({ ...v, vehicle: e.target.value })} /></Field>
        <Field label={t('notes')}><input value={v.notes} onChange={e => setV({ ...v, notes: e.target.value })} /></Field>
        <div className="modal-foot"><span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary">{t('save')}</button></div>
      </form>
    </Modal>
  )
}

function RunDetail({ run, data, unassigned, onClose, reload }) {
  const t = useT()
  const toast = useToast()
  const [printing, setPrinting] = useState(false)
  const stops = data.orders.filter(o => o.delivery_id === run.id)
  const cust = id => data.customers.find(c => c.id === id) || {}
  const prod = id => data.products.find(p => p.id === id) || {}
  const locked = run.status === 'done'

  // loading list: total per product across all stops
  const load = {}
  stops.forEach(o => o.order_lines.forEach(l => { load[l.product_id] = (load[l.product_id] || 0) + Number(l.qty) }))

  const act = async (p, msg) => { try { await q(p); if (msg) toast(msg); await reload() } catch (e) { toast(errText(e), 'error') } }

  function print() {
    setPrinting(true)
    setTimeout(() => { window.print(); setPrinting(false) }, 50)
  }

  return (
    <Modal wide title={`D${run.no} · ${run.driver || ''} ${run.vehicle ? '· ' + run.vehicle : ''}`} onClose={onClose}>
      <div className="detail-meta"><Status value={run.status} prefix="d" /><span>{fmtDate(run.delivery_date, t.lang)}</span></div>

      {Object.keys(load).length > 0 && (
        <div className="load-list">
          {Object.entries(load).map(([pid, qty]) => (
            <span key={pid} className="load-chip"><b>{fmtNum(qty, t.lang)}</b> {prod(pid).unit} {t.pick(prod(pid))}</span>
          ))}
        </div>
      )}

      <ol className="stop-list numbered">
        {stops.map(o => {
          const c = cust(o.customer_id)
          return (
            <li key={o.id}>
              <div className="stop-main">
                <b>#{o.no} {c.name}</b>
                <span className="muted">{c.address} {c.phone ? `· ${c.phone}` : ''}</span>
                {c.delivery_notes && <span className="small">{c.delivery_notes}</span>}
                <span className="small">{o.order_lines.map(l => `${t.pick(prod(l.product_id))} ${fmtNum(l.qty, t.lang)}${prod(l.product_id).unit}`).join(', ')}</span>
              </div>
              {!locked && <button className="btn btn-quiet" onClick={() => act(db.from('orders').update({ delivery_id: null }).eq('id', o.id))}>{t('remove')}</button>}
            </li>
          )
        })}
      </ol>

      {!locked && unassigned.length > 0 && (
        <section className="subsection">
          <h3>{t('unassigned')}</h3>
          <ul className="stop-list">
            {unassigned.map(o => (
              <li key={o.id}>
                <div className="stop-main"><b>#{o.no} {cust(o.customer_id).name}</b><span className="muted">{cust(o.customer_id).address}</span></div>
                <button className="btn btn-sm" onClick={() => act(db.from('orders').update({ delivery_id: run.id }).eq('id', o.id))}>{t('assign')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="modal-foot">
        {stops.length > 0 && <button className="btn" onClick={print}>{t('print')} {t('deliveryNote')}</button>}
        <span className="grow" />
        {run.status === 'planned' && stops.length > 0 && <button className="btn" onClick={() => act(db.from('deliveries').update({ status: 'out' }).eq('id', run.id))}>{t('depart')}</button>}
        {!locked && stops.length > 0 && <button className="btn btn-primary"
          onClick={() => confirm(t('completeDelivery') + '?') && act(db.rpc('complete_delivery', { p_delivery_id: run.id }), t('d_done'))}>{t('completeDelivery')}</button>}
      </div>

      {printing && createPortal(
        <div className="print-only">
          {stops.map(o => {
            const c = cust(o.customer_id)
            const total = o.order_lines.reduce((s, l) => s + l.qty * l.unit_price, 0)
            return (
              <article key={o.id} className="dnote">
                <header><h1>{t('deliveryNote')} #{o.no}</h1><p>{fmtDate(o.delivery_date, t.lang)} · D{run.no} {run.driver || ''}</p></header>
                <p><b>{c.name}</b><br />{c.address}<br />{c.vat_no ? `${t('vatNo')}: ${c.vat_no}` : ''}</p>
                <table>
                  <thead><tr><th>{t('name')}</th><th>{t('qty')}</th><th>{t('price')}</th><th>{t('total')}</th></tr></thead>
                  <tbody>{o.order_lines.map(l => (
                    <tr key={l.id}><td>{t.pick(prod(l.product_id))}</td><td>{fmtNum(l.qty, t.lang)} {prod(l.product_id).unit}</td>
                      <td>{fmtFt(l.unit_price, t.lang)}</td><td>{fmtFt(l.qty * l.unit_price, t.lang)}</td></tr>
                  ))}</tbody>
                  <tfoot><tr><td colSpan={3}>{t('total')}</td><td>{fmtFt(total, t.lang)}</td></tr></tfoot>
                </table>
                {o.notes && <p>{t('notes')}: {o.notes}</p>}
                <p className="sign">{t('signature')}: ______________________</p>
              </article>
            )
          })}
        </div>, document.body)}
    </Modal>
  )
}
