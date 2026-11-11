import { useEffect, useMemo, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtNum } from '../lib/i18n'
import { Modal, Field, Loading, NumInput, useToast, errText } from './ui'
import { LABEL_SIZES, drawSimpleLabel, labelFontsReady, fmtLabelQty } from './LabelPrint'
import { isTouch, shareCanvases, pdfFromCanvases, deliverPdf } from '../lib/labelOutput'

// label wording in the label's own language
const W = {
  hu: { lot: 'Tétel', received: 'Beérkezett', expiry: 'Lejárat', supplier: 'Beszállító', qty: 'Mennyiség', recorder: 'Rögzítő', opened: 'Bontva',
        units: { kg: 'kg', g: 'g', l: 'liter', ml: 'ml', pcs: 'darab', pack: 'csomag', box: 'doboz' } },
  en: { lot: 'Lot', received: 'Received', expiry: 'Expiry', supplier: 'Supplier', qty: 'Quantity', recorder: 'Recorded by', opened: 'Opened',
        units: { kg: 'kg', g: 'g', l: 'l', ml: 'ml', pcs: 'pcs', pack: 'pack', box: 'box' } },
  zh: { lot: '批号', received: '入库', expiry: '到期', supplier: '供应商', qty: '数量', recorder: '记录人', opened: '开封',
        units: { kg: '公斤', g: '克', l: '升', ml: '毫升', pcs: '个', pack: '包', box: '箱' } },
}
const KEY = 'nf-rlabel-v1'
const read = d => { try { return { ...d, ...JSON.parse(localStorage.getItem(KEY)) } } catch { return d } }
const write = v => { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* private mode */ } }
const ymd = d => {
  if (!d) return ''
  const x = new Date(typeof d === 'string' && d.length === 10 ? d + 'T00:00:00' : d)
  return `${x.getFullYear()}.${String(x.getMonth() + 1).padStart(2, '0')}.${String(x.getDate()).padStart(2, '0')}.`
}
const nameIn = (row, lang) => row?.[`name_${lang}`] || row?.name_hu || row?.name_en || row?.name_zh || ''

// goods-in labels for a received purchase order: one row per material, any number of copies
export default function ReceiveLabels({ poId, onClose }) {
  const t = useT()
  const toast = useToast()
  const { profile } = useAuth()
  const [opt, setOpt] = useState(() => read({ size: 'dk22205', length: 40, lang: 'hu', cw: 62, ch: 40, opened: true, supplier: true }))
  const set = patch => setOpt(o => { const n = { ...o, ...patch }; write(n); return n })
  const [recorder, setRecorder] = useState(profile?.display_name || '')
  const [rows, setRows] = useState(null)        // [{ id, on, copies, per }]
  const [fontTick, setFontTick] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => { labelFontsReady().then(() => setFontTick(x => x + 1)) }, [])

  const { data, error } = useData(async () => {
    const po = await q(db.from('purchase_orders').select('id,no,received_at,order_date,supplier_id').eq('id', poId).single())
    const [lines, supplier] = await Promise.all([
      q(db.from('purchase_order_lines').select('id,qty,received_qty,lot_no,expiry_date, materials(name_zh,name_en,name_hu,unit,pack_size)').eq('po_id', poId)),
      po.supplier_id ? q(db.from('suppliers').select('name').eq('id', po.supplier_id).maybeSingle()) : Promise.resolve(null),
    ])
    return { po, lines: lines.filter(l => Number(l.received_qty ?? l.qty) > 0), supplier }
  }, [poId])
  useEffect(() => {
    // one label per bag when the material has a pack size (e.g. 120 kg of 40 kg bags → 3 labels of 40 kg)
    if (data && !rows) setRows(data.lines.map(l => {
      const pack = Number(l.materials?.pack_size) || 0
      const total = Number(l.received_qty ?? l.qty)
      const bags = pack ? Math.ceil(total / pack - 1e-9) : 1
      return { id: l.id, on: true, copies: Math.min(Math.max(bags, 1), 50), per: pack && bags > 1 ? pack : null }
    }))
  }, [data, rows])

  const size = LABEL_SIZES.find(s => s.id === opt.size) || LABEL_SIZES[0]
  const w = size.custom ? (opt.cw || 62) : size.w
  const h = size.custom ? (opt.ch || 40) : size.cont ? (opt.length || 40) : size.h

  const textFor = (line, row) => {
    const T = W[opt.lang] || W.hu
    const m = line.materials || {}
    const total = Number(line.received_qty ?? line.qty)
    const per = row.per ?? (row.copies > 0 ? total / row.copies : total)
    return [
      { text: nameIn(m, opt.lang), bold: true },
      line.lot_no && { text: `${T.lot}: ${line.lot_no}` },
      { text: `${T.received}: ${ymd(data.po.received_at || data.po.order_date)}` },
      line.expiry_date && { text: `${T.expiry}: ${ymd(line.expiry_date)}` },
      opt.supplier && data.supplier?.name && { text: `${T.supplier}: ${data.supplier.name}` },
      per > 0 && { text: `${T.qty}: ${fmtLabelQty(per, m.unit, T.units)}` },
      recorder && { text: `${T.recorder}: ${recorder}` },
      opt.opened && { text: `${T.opened}: ______________` },
    ].filter(Boolean)
  }

  const picked = useMemo(() => (data && rows) ? data.lines.map((l, i) => ({ l, r: rows[i] })).filter(x => x.r?.on && x.r.copies > 0) : [],
    [data, rows])
  const count = picked.reduce((s, x) => s + Math.min(x.r.copies, 50), 0)
  const first = picked[0]
  const preview = useMemo(() => first ? drawSimpleLabel({ w, h, textLines: textFor(first.l, first.r) }).toDataURL('image/png') : '',
    [first, w, h, opt, recorder, fontTick]) // eslint-disable-line react-hooks/exhaustive-deps

  function canvases() {
    const out = []
    picked.forEach(({ l, r }) => {
      const lines = textFor(l, r)
      for (let i = 0; i < Math.min(r.copies, 50); i++) out.push(drawSimpleLabel({ w, h, textLines: lines }))
    })
    return out
  }
  async function print(kind) {
    setBusy(true)
    try {
      await labelFontsReady()
      const cs = canvases()
      if (kind === 'images') await shareCanvases(cs, `P${data.po.no}`)
      else await deliverPdf(pdfFromCanvases(cs, w, h), `P${data.po.no}-labels`)
    } catch (e) { if (e?.name !== 'AbortError') toast(errText(e), 'error') }
    finally { setBusy(false) }
  }

  if (error) return <Modal title={t('printLabels')} onClose={onClose}><p className="error-box">{errText(error)}</p></Modal>
  if (!data || !rows) return <Modal title={t('printLabels')} onClose={onClose}><Loading /></Modal>
  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r))
  const touch = isTouch()

  return (
    <Modal wide title={`${t('goodsInLabels')} · P${data.po.no}${data.supplier?.name ? ' · ' + data.supplier.name : ''}`} onClose={onClose}>
      <div className="table-wrap"><table className="table compact">
        <thead><tr><th /><th>{t('nav_materials')}</th><th className="num">{t('copies')}</th><th className="num">{t('qtyPerLabel')}</th></tr></thead>
        <tbody>{data.lines.map((l, i) => {
          const r = rows[i], m = l.materials || {}
          const total = Number(l.received_qty ?? l.qty)
          return (
            <tr key={l.id} className={r.on ? '' : 'row-off'}>
              <td><input type="checkbox" checked={r.on} aria-label={nameIn(m, t.lang)} onChange={e => setRow(i, { on: e.target.checked })} /></td>
              <td><b>{t.pick(m)}</b><div className="muted small">{l.lot_no || '–'} · {fmtNum(total, t.lang)} {m.unit}</div></td>
              <td className="num"><NumInput className="input-sm" value={r.copies} min={1} max={50} onChange={v => setRow(i, { copies: v })} aria-label={t('copies')} /></td>
              <td className="num"><NumInput className="input-sm" value={r.per ?? (r.copies > 0 ? Math.round(total / r.copies * 1000) / 1000 : total)} min={0}
                onChange={v => setRow(i, { per: v })} aria-label={t('qtyPerLabel')} /> <span className="unit">{m.unit}</span></td>
            </tr>
          )
        })}</tbody>
      </table></div>
      <div className="label-layout" style={{ marginTop: 14 }}>
        <div className="stack">
          <div className="form-grid">
            <Field label={t('labelSize')}>
              <select value={opt.size} onChange={e => set({ size: e.target.value })}>
                {LABEL_SIZES.map(s => <option key={s.id} value={s.id}>{s.custom ? t('customSize') : s.name}</option>)}
              </select>
            </Field>
            {size.cont && <Field label={t('labelLength')}><NumInput value={opt.length} min={20} max={300} onChange={v => set({ length: v })} /></Field>}
            {size.custom && <>
              <Field label={t('labelWidth')}><NumInput value={opt.cw} min={20} max={200} onChange={v => set({ cw: v })} /></Field>
              <Field label={t('labelHeight')}><NumInput value={opt.ch} min={15} max={300} onChange={v => set({ ch: v })} /></Field>
            </>}
            <Field label={t('labelLang')}>
              <select value={opt.lang} onChange={e => set({ lang: e.target.value })}>
                <option value="hu">Magyar</option><option value="en">English</option><option value="zh">中文</option>
              </select>
            </Field>
            <Field label={t('recorder')}><input value={recorder} onChange={e => setRecorder(e.target.value)} /></Field>
          </div>
          <label className="check-inline"><input type="checkbox" checked={!!opt.supplier} onChange={e => set({ supplier: e.target.checked })} />{t('showSupplierLine')}</label>
          <label className="check-inline"><input type="checkbox" checked={!!opt.opened} onChange={e => set({ opened: e.target.checked })} />{t('openedLine')}</label>
        </div>
        <div className="label-preview-wrap">
          <p className="muted small">{t('labelPreview')} · {w} × {h} mm</p>
          {preview ? <div className="label-preview" style={{ width: `${w * Math.min(1.8, 300 / w)}mm`, aspectRatio: `${w} / ${h}` }}>
            <img src={preview} alt="" style={{ width: '100%', height: 'auto', display: 'block' }} />
          </div> : <p className="muted">{t('nothingSelected')}</p>}
          <p className="muted small label-hint">{t('labelHint')}</p>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn btn-quiet" disabled={!count || busy} onClick={() => print(touch ? 'pdf' : 'images')}>{touch ? t('sharePdf') : t('shareImage')}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('close')}</button>
        <button className="btn btn-primary" disabled={!count || busy} onClick={() => print(touch ? 'images' : 'pdf')}>{t('print')} × {count}</button>
      </div>
    </Modal>
  )
}
