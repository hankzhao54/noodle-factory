import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { toPng } from 'html-to-image'
import { jsPDF } from 'jspdf'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtNum } from '../lib/i18n'
import { Modal, Field, Loading, NumInput, useToast, errText } from './ui'

/* Brother DK rolls that fit the QL-810W. w × h = the label as it is read (mm). */
export const LABEL_SIZES = [
  { id: 'dk22205', name: '62 mm (DK-22205)', w: 62, h: null, cont: true },
  { id: 'dk11209', name: '62 × 29 mm (DK-11209)', w: 62, h: 29 },
  { id: 'dk11202', name: '62 × 100 mm (DK-11202)', w: 62, h: 100 },
  { id: 'dk11201', name: '29 × 90 mm (DK-11201)', w: 90, h: 29 },
  { id: 'dk11208', name: '38 × 90 mm (DK-11208)', w: 90, h: 38 },
  { id: 'custom', name: 'custom', w: 62, h: 50, custom: true },
]

// fixed label wording, in the label's own language (independent of the UI language)
const L = {
  hu: { id: 'Azon', recorder: 'Rögzítő', producedAt: 'Gyártás időp.', qty: 'Mennyiség', units: { g: 'gramm', kg: 'kg', pcs: 'darab' }, produced: 'Gyártva', useBy: 'Fogyasztható', lot: 'Tétel', storage: 'Tárolás', net: 'Nettó tömeg', allergens: 'Allergének', ingredients: 'Összetevők', producer: 'Gyártó' },
  en: { id: 'ID', recorder: 'Recorded by', producedAt: 'Produced', qty: 'Quantity', units: { g: 'g', kg: 'kg', pcs: 'pcs' }, produced: 'Produced', useBy: 'Use by', lot: 'Lot', storage: 'Storage', net: 'Net weight', allergens: 'Allergens', ingredients: 'Ingredients', producer: 'Producer' },
  zh: { id: '编号', recorder: '记录人', producedAt: '生产时间', qty: '数量', units: { g: '克', kg: '公斤', pcs: '个' }, produced: '生产日期', useBy: '保质期至', lot: '批号', storage: '储存', net: '净含量', allergens: '过敏原', ingredients: '配料', producer: '生产商' },
}
// the 14 EU allergens, keyed by common spellings
const ALLERGEN = {
  gluten: ['glutén', 'gluten', '麸质'], egg: ['tojás', 'egg', '蛋'], milk: ['tej', 'milk', '乳'],
  soy: ['szója', 'soy', '大豆'], sesame: ['szezámmag', 'sesame', '芝麻'], mustard: ['mustár', 'mustard', '芥末'],
  celery: ['zeller', 'celery', '芹菜'], fish: ['hal', 'fish', '鱼'], crustaceans: ['rákfélék', 'crustaceans', '甲壳类'],
  molluscs: ['puhatestűek', 'molluscs', '软体动物'], nuts: ['diófélék', 'nuts', '坚果'], peanuts: ['földimogyoró', 'peanuts', '花生'],
  lupin: ['csillagfürt', 'lupin', '羽扇豆'], sulphites: ['kén-dioxid, szulfitok', 'sulphites', '亚硫酸盐'],
}
const LI = { hu: 0, en: 1, zh: 2 }
function allergenName(raw, lang) {
  const k = String(raw).trim().toLowerCase()
  for (const [key, names] of Object.entries(ALLERGEN)) {
    if (key === k || names.some(n => n.toLowerCase() === k)) return names[LI[lang]]
  }
  return raw
}
// rough weight for ordering the ingredient list (heaviest first)
const KG = { kg: 1, g: 0.001, l: 1, ml: 0.001 }
const toKg = l => Number(l.qty_per_batch) * (KG[l.materials?.unit] ?? 1)
const nameIn = (row, lang) => row?.[`name_${lang}`] || row?.name_hu || row?.name_en || row?.name_zh || ''
const ymd = d => {
  if (!d) return ''
  const x = new Date(typeof d === 'string' && d.length === 10 ? d + 'T00:00:00' : d)
  return `${x.getFullYear()}.${String(x.getMonth() + 1).padStart(2, '0')}.${String(x.getDate()).padStart(2, '0')}.`
}
const ymdhm = d => {
  if (!d) return ''
  const x = new Date(d)
  return `${ymd(x)} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`
}
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } }

export function traceUrl(lot) {
  return `${window.location.origin}/trace/${encodeURIComponent(lot)}`
}

export default function LabelPrint({ batchId, onClose }) {
  const t = useT()
  const toast = useToast()
  const { isAdmin, profile } = useAuth()
  const [opt, setOpt] = useState(() => ({
    size: 'dk22205', length: 28, lang: 'hu', ingredients: true, cw: 62, ch: 28, template: 'simple',
    ...read('nf-label-v2', {}),
  }))
  const [recorder, setRecorder] = useState(profile?.display_name || '')
  const [amount, setAmount] = useState(null)
  const [unit, setUnit] = useState('g')
  const [fitPt, setFitPt] = useState(null)
  const [copies, setCopies] = useState(1)
  const [printing, setPrinting] = useState(false)
  const [pdfJob, setPdfJob] = useState(null)      // { win } while building the PDF
  const [pdfUrl, setPdfUrl] = useState(null)
  const renderBox = useRef(null)
  const [qr, setQr] = useState('')
  const [settings, setSettings] = useState(null)
  const set = patch => setOpt(o => { const n = { ...o, ...patch }; write('nf-label-v2', n); return n })

  const { data, error } = useData(async () => {
    const batch = await q(db.from('production_batches').select('*').eq('id', batchId).single())
    const [product, lines, cfg, out] = await Promise.all([
      q(db.from('products').select('*').eq('id', batch.product_id).single()),
      q(db.from('recipe_lines').select('qty_per_batch, materials(name_zh,name_en,name_hu,unit,allergens,on_label)').eq('product_id', batch.product_id)),
      q(db.from('settings').select('key,value')),
      q(db.from('stock_movements').select('expiry_date').eq('ref_id', batchId).eq('reason', 'production_out').limit(1)),
    ])
    return { batch, product, lines, cfg: Object.fromEntries(cfg.map(r => [r.key, r.value || ''])), expiry: out[0]?.expiry_date }
  }, [batchId])

  useEffect(() => { if (data && !settings) setSettings(data.cfg) }, [data, settings])
  // default quantity per label: the product's portion size, else the whole batch
  useEffect(() => {
    if (!data || amount !== null) return
    const p = data.product
    if (p.pack_size_g) { setAmount(Number(p.pack_size_g)); setUnit('g') }
    else { setAmount(Number(data.batch.actual_qty) || 1); setUnit(p.unit === 'kg' ? 'kg' : p.unit === 'g' ? 'g' : 'pcs') }
  }, [data, amount])
  const lot = data?.batch.lot_no || ''
  useEffect(() => {
    if (!lot) return
    QRCode.toString(traceUrl(lot), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(setQr)
  }, [lot])

  const size = LABEL_SIZES.find(s => s.id === opt.size) || LABEL_SIZES[0]
  const w = size.custom ? (opt.cw || 62) : size.w
  const h = size.custom ? (opt.ch || 50) : size.cont ? (opt.length || 50) : size.h

  // print: add a page-size rule just for this job, then remove it
  useEffect(() => {
    if (!printing) return
    const style = document.createElement('style')
    style.textContent = `@media print { @page { size: ${w}mm ${h}mm; margin: 0; } }`
    document.head.appendChild(style)
    // iPhone Safari returns from print() before it has printed, so keep the labels
    // on the page until the browser says printing is over
    const done = () => { style.remove(); setPrinting(false) }
    window.addEventListener('afterprint', done, { once: true })
    const id = setTimeout(() => window.print(), 80)
    const safety = setTimeout(done, 120000)
    return () => { clearTimeout(id); clearTimeout(safety); window.removeEventListener('afterprint', done); style.remove() }
  }, [printing, w, h])

  // PDF with pages exactly the label size. iPhone: system share sheet (contains Print),
  // computer: open the PDF in a new tab. No pop-up window (Safari blocks those).
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  const [fullPdf, setFullPdf] = useState(null)   // built asynchronously for the full template

  function deliverPdf(blob) {
    const file = new File([blob], `label-${lot}.pdf`, { type: 'application/pdf' })
    if (touch && navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file] }).catch(e => { if (e?.name !== 'AbortError') openBlob(blob) })
      return
    }
    openBlob(blob)
  }
  function openBlob(blob) {
    const url = URL.createObjectURL(blob)
    setPdfUrl(old => { if (old) URL.revokeObjectURL(old); return url })
    const win = window.open(url, '_blank')
    if (!win) window.location.href = url
  }
  function newPdf() {
    return new jsPDF({ unit: 'mm', format: [w, h], orientation: w > h ? 'landscape' : 'portrait', compress: true })
  }

  function printSimple() {
    try {
      const pdf = newPdf()
      for (let i = 0; i < Math.min(copies, 200); i++) {
        if (i) pdf.addPage([w, h], w > h ? 'landscape' : 'portrait')
        const c = drawSimpleLabel({ ...label, labelId: idFor(i) })
        pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, 0, w, h, undefined, 'FAST')
      }
      deliverPdf(pdf.output('blob'))
    } catch (e) { toast(errText(e), 'error') }
  }

  useEffect(() => {
    if (!pdfJob) return
    let cancelled = false
    ;(async () => {
      try {
        await (document.fonts?.ready || Promise.resolve())
        await new Promise(r => setTimeout(r, 50))
        const nodes = [...(renderBox.current?.children || [])]
        const pdf = newPdf()
        for (let i = 0; i < nodes.length; i++) {
          const png = await toPng(nodes[i], { pixelRatio: 4, backgroundColor: '#ffffff' })
          if (i) pdf.addPage([w, h], w > h ? 'landscape' : 'portrait')
          pdf.addImage(png, 'PNG', 0, 0, w, h, undefined, 'FAST')
        }
        if (!cancelled) setFullPdf(pdf.output('blob'))
      } catch (e) { toast(errText(e), 'error') }
      finally { if (!cancelled) setPdfJob(null) }
    })()
    return () => { cancelled = true }
  }, [pdfJob]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl) }, [pdfUrl])
  // any change to the label makes a prepared full PDF stale
  useEffect(() => { setFullPdf(null) }, [opt, copies, recorder, amount, unit, settings])

  async function saveSettings() {
    try {
      await q(db.from('settings').upsert(Object.entries(settings).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }))))
      toast(t('saved'))
    } catch (e) { toast(errText(e), 'error') }
  }

  if (error) return <Modal title={t('printLabels')} onClose={onClose}><p className="error-box">{errText(error)}</p></Modal>
  if (!data || !settings) return <Modal title={t('printLabels')} onClose={onClose}><Loading /></Modal>

  const simple = opt.template === 'simple'
  const label = { ...data, lot, qr, settings, lang: opt.lang, ingredients: opt.ingredients, w, h,
                  simple, recorder, amount, unit }
  const idFor = i => copies > 1 ? `${lot}-${String(i + 1).padStart(2, '0')}` : lot
  const scale = Math.min(1.8, 300 / w)

  return (
    <Modal wide title={`${t('printLabels')} · ${t.pick(data.product)} · ${lot}`} onClose={onClose}>
      <div className="label-layout">
        <div className="stack">
          <Field label={t('labelTemplate')}>
            <select value={opt.template} onChange={e => set({ template: e.target.value })}>
              <option value="simple">{t('templateSimple')}</option>
              <option value="full">{t('templateFull')}</option>
            </select>
          </Field>
          <Field label={t('labelSize')}>
            <select value={opt.size} onChange={e => set({ size: e.target.value })}>
              {LABEL_SIZES.map(s => <option key={s.id} value={s.id}>{s.custom ? t('customSize') : s.name}</option>)}
            </select>
          </Field>
          {size.cont && <Field label={t('labelLength')}><NumInput value={opt.length} min={20} max={300} onChange={v => set({ length: v })} /></Field>}
          {size.custom && <div className="row-gap">
            <Field label={t('labelWidth')}><NumInput value={opt.cw} min={20} max={200} onChange={v => set({ cw: v })} /></Field>
            <Field label={t('labelHeight')}><NumInput value={opt.ch} min={15} max={300} onChange={v => set({ ch: v })} /></Field>
          </div>}
          <Field label={t('labelLang')}>
            <select value={opt.lang} onChange={e => set({ lang: e.target.value })}>
              <option value="hu">Magyar</option><option value="en">English</option><option value="zh">中文</option>
            </select>
          </Field>
          {simple ? <>
            <Field label={t('recorder')}><input value={recorder} onChange={e => setRecorder(e.target.value)} /></Field>
            <Field label={t('qtyPerLabel')}>
              <div className="row-gap nowrap">
                <NumInput value={amount} min={0} onChange={setAmount} style={{ flex: 1 }} />
                <select value={unit} onChange={e => setUnit(e.target.value)} style={{ width: 'auto' }}>
                  <option value="g">gramm</option><option value="kg">kg</option><option value="pcs">darab</option>
                </select>
              </div>
            </Field>
          </> : <label className="check-inline"><input type="checkbox" checked={opt.ingredients} onChange={e => set({ ingredients: e.target.checked })} />{t('showIngredients')}</label>}
          <Field label={t('copies')} hint={copies > 1 ? t('copiesIdHint', { a: idFor(0), b: idFor(copies - 1) }) : null}><NumInput value={copies} min={1} max={200} onChange={v => setCopies(v)} /></Field>

          {!simple && <details className="label-producer">
            <summary>{t('producerInfo')}{!settings.label_producer && <span className="tag tag-low">{t('missing')}</span>}</summary>
            <Field label={t('producerName')}><input value={settings.label_producer} disabled={!isAdmin} onChange={e => setSettings(s => ({ ...s, label_producer: e.target.value }))} /></Field>
            <Field label={t('producerAddress')}><input value={settings.label_address} disabled={!isAdmin} onChange={e => setSettings(s => ({ ...s, label_address: e.target.value }))} /></Field>
            <Field label={t('labelExtra')}><input value={settings.label_extra} disabled={!isAdmin} onChange={e => setSettings(s => ({ ...s, label_extra: e.target.value }))} /></Field>
            {isAdmin && <button className="btn btn-sm" onClick={saveSettings}>{t('saveForAll')}</button>}
          </details>}
        </div>

        <div className="label-preview-wrap">
          <p className="muted small">{t('labelPreview')} · {w} × {h} mm</p>
          {simple ? (
            <div className="label-preview" style={{ width: `${w * scale}mm`, aspectRatio: `${w} / ${h}` }}>
              <CanvasPreview {...label} labelId={idFor(Math.max(0, (copies || 1) - 1))} />
            </div>
          ) : (
            <div className="label-preview" style={{ width: `${w * scale}mm`, height: `${h * scale}mm` }}>
              <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                <Label {...label} labelId={idFor(Math.max(0, (copies || 1) - 1))} measure onFit={setFitPt} />
              </div>
            </div>
          )}
          <p className="muted small label-hint">{t('labelHint')}</p>
        </div>
      </div>

      <div className="modal-foot">
        <button className="btn btn-quiet" disabled={!qr || !(copies > 0) || printing} onClick={() => setPrinting(true)}>{t('browserPrint')}</button>
        {pdfUrl && <a className="btn btn-quiet" href={pdfUrl} target="_blank" rel="noreferrer">{t('openPdfAgain')}</a>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('close')}</button>
        {simple ? (
          <button className="btn btn-primary" disabled={!(copies > 0)} onClick={printSimple}>{t('print')} × {copies || 0}</button>
        ) : fullPdf ? (
          <button className="btn btn-primary" onClick={() => deliverPdf(fullPdf)}>{t('pdfReadyPrint')}</button>
        ) : (
          <button className="btn btn-primary" disabled={!qr || !(copies > 0) || !!pdfJob} onClick={() => setPdfJob({})}>
            {pdfJob ? t('makingPdf') : `${t('print')} × ${copies || 0}`}
          </button>
        )}
      </div>

      {pdfJob && createPortal(
        <div className="label-render" ref={renderBox} aria-hidden="true">
          {Array.from({ length: Math.min(copies, 200) }).map((_, i) => <Label key={i} {...label} labelId={idFor(i)} fitPt={fitPt} />)}
        </div>, document.body)}

      {printing && createPortal(
        <div className="print-only label-print">
          {Array.from({ length: Math.min(copies, 200) }).map((_, i) => <Label key={i} {...label} labelId={idFor(i)} fitPt={fitPt} />)}
        </div>, document.body)}
    </Modal>
  )
}

/* one label, sized in mm; layout adapts to the shape */
export function Label(props) {
  if (props.simple) return <SimpleLabel {...props} />
  return <FullLabel {...props} />
}

/* ---- simple label drawn straight onto a canvas (what you see = what prints) ---- */
const DPI = 300
const PX_PER_MM = DPI / 25.4
const FONT = 'Archivo, "Noto Sans SC", "Helvetica Neue", Helvetica, Arial, sans-serif'

function simpleLines({ product, batch, expiry, lang, recorder, amount, unit, labelId }) {
  const T = L[lang] || L.hu
  const produced = batch.done_at || batch.planned_date
  const useBy = product.shelf_life_days != null && produced
    ? new Date(new Date(produced).getTime() + product.shelf_life_days * 864e5) : expiry
  return [
    { text: nameIn(product, lang), bold: true },
    { text: `${T.id}: ${labelId}` },
    recorder && { text: `${T.recorder}: ${recorder}` },
    { text: `${T.producedAt}: ${ymdhm(produced)}` },
    useBy && { text: `${T.useBy}: ${ymdhm(useBy)}` },
    amount > 0 && { text: `${T.qty}: ${fmtNum(amount, 'hu', 3)} ${T.units[unit] || unit}` },
  ].filter(Boolean)
}

export function drawSimpleLabel(props) {
  const { w, h, lot } = props
  const W = Math.round(w * PX_PER_MM), H = Math.round(h * PX_PER_MM)
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H)
  g.fillStyle = '#000'
  const pad = 1.8 * PX_PER_MM, gap = 1.6 * PX_PER_MM

  // QR: whole-pixel modules so it stays sharp on a 300 dpi head
  const qr = QRCode.create(traceUrl(lot), { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const cell = Math.max(1, Math.floor((Math.min(h * 0.72, w * 0.3) * PX_PER_MM) / n))
  const qrPx = cell * n
  const qx = Math.round(pad), qy = Math.round((H - qrPx) / 2)
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (qr.modules.data[r * n + col]) g.fillRect(qx + col * cell, qy + r * cell, cell, cell)
  }

  // text: biggest size (≤ 9 pt) at which every line fits
  const x0 = qx + qrPx + gap, maxW = W - x0 - pad, maxH = H - 2 * pad
  const lines = simpleLines(props)
  const fontOf = (l, px) => `${l.bold ? 700 : 400} ${l.bold ? px * 1.08 : px}px ${FONT}`
  let pt = 9, px, lh
  for (; pt >= 4.5; pt = Math.round((pt - 0.2) * 10) / 10) {
    px = pt * DPI / 72; lh = px * 1.2
    const widest = Math.max(...lines.map(l => { g.font = fontOf(l, px); return g.measureText(l.text).width }))
    if (widest <= maxW && lines.length * lh <= maxH) break
  }
  g.textBaseline = 'middle'
  let y = (H - lines.length * lh) / 2 + lh / 2
  for (const l of lines) { g.font = fontOf(l, px); g.fillText(l.text, x0, y); y += lh }
  return c
}

function CanvasPreview(props) {
  const [src, setSrc] = useState('')
  const [fontTick, setFontTick] = useState(0)
  useEffect(() => { document.fonts?.ready?.then(() => setFontTick(x => x + 1)) }, [])
  const key = JSON.stringify([props.w, props.h, props.lot, props.lang, props.recorder, props.amount, props.unit, props.labelId, fontTick])
  useEffect(() => { setSrc(drawSimpleLabel(props).toDataURL('image/png')) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return <img src={src} alt="" style={{ width: '100%', height: 'auto', display: 'block' }} />
}

/* same layout as the OkoHACCP labels: QR left, six lines right */
function SimpleLabel({ product, batch, expiry, qr, lang, w, h, recorder, amount, unit, labelId, measure, fitPt, onFit }) {
  const T = L[lang] || L.hu
  const produced = batch.done_at || batch.planned_date
  const useBy = product.shelf_life_days != null && produced
    ? new Date(new Date(produced).getTime() + product.shelf_life_days * 864e5)
    : expiry
  const qrSize = Math.min(h * 0.72, w * 0.3)
  // shrink the text until every line fits (never cut off a date)
  // Only the on-screen preview can be measured (print copies are hidden), so it finds
  // the size and reports it; the printed copies use that size.
  const box = useRef(null)
  const [pt, setPt] = useState(9)
  useLayoutEffect(() => { if (measure) setPt(9) }, [measure, w, h, recorder, amount, unit, labelId, lang])
  // re-measure once the web font has loaded (it is wider than the fallback)
  useEffect(() => {
    if (!measure || !document.fonts?.ready) return
    let live = true
    document.fonts.ready.then(() => { if (live) setPt(9) })
    return () => { live = false }
  }, [measure])
  useLayoutEffect(() => {
    if (!measure) return
    const el = box.current
    if (el && pt > 5 && (el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5)) setPt(p => Math.round((p - 0.2) * 10) / 10)
    else onFit?.(pt)
  }, [measure, pt, w, h, recorder, amount, unit, labelId, lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const size = measure ? pt : (fitPt || 9)
  return (
    <div className="label label-simple" style={{ width: `${w}mm`, height: `${h}mm` }}>
      <div className="label-qr" style={{ width: `${qrSize}mm`, height: `${qrSize}mm` }} dangerouslySetInnerHTML={{ __html: qr }} />
      <div className="label-lines" ref={box} style={{ fontSize: `${size}pt` }}>
        <b>{nameIn(product, lang)}</b>
        <span>{T.id}: {labelId}</span>
        {recorder && <span>{T.recorder}: {recorder}</span>}
        <span>{T.producedAt}: {ymdhm(produced)}</span>
        {useBy && <span>{T.useBy}: {ymdhm(useBy)}</span>}
        {amount > 0 && <span>{T.qty}: {fmtNum(amount, 'hu', 3)} {T.units[unit] || unit}</span>}
      </div>
    </div>
  )
}

function FullLabel({ product, lines, batch, expiry, lot, qr, settings, lang, ingredients, w, h }) {
  const T = L[lang] || L.hu
  const wide = w / h > 2.2 || h < 35   // short labels (29×90, 62×29): compact, allergens only
  const produced = batch.done_at || batch.planned_date
  const useBy = expiry || (product.shelf_life_days != null && produced
    ? new Date(new Date(produced).getTime() + product.shelf_life_days * 864e5) : null)

  const sorted = useMemo(() => lines
    .filter(l => l.materials?.on_label !== false)
    .sort((a, b) => toKg(b) - toKg(a)), [lines])
  const allergenSet = new Set()
  lines.forEach(l => (l.materials?.allergens || []).forEach(a => allergenSet.add(allergenName(a, lang))))
  const tall = !wide && h >= 70
  const qrSize = wide ? h - 4 : Math.min(h - 6, tall ? Math.min(34, w * 0.42) : 22)

  return (
    <div className={`label ${wide ? 'label-wide' : ''} ${tall ? 'label-tall' : ''}`} style={{ width: `${w}mm`, height: `${h}mm` }}>
      <div className="label-qr" style={{ width: `${qrSize}mm`, height: `${qrSize}mm` }} dangerouslySetInnerHTML={{ __html: qr }} />
      <div className="label-body">
        <div className="label-name">{nameIn(product, lang)}</div>
        <div className="label-grid">
          <span>{T.lot}</span><b>{lot}</b>
          <span>{T.produced}</span><b>{ymd(produced)}</b>
          {useBy && <><span>{T.useBy}</span><b>{ymd(useBy)}</b></>}
          {product.pack_size_g && <><span>{T.net}</span><b>{fmtNum(product.pack_size_g, 'hu')} g</b></>}
          {!wide && product.storage && <><span>{T.storage}</span><b>{product.storage}</b></>}
        </div>
        {!wide && ingredients && sorted.length > 0 && (
          <p className="label-ingr"><span>{T.ingredients}: </span>
            {sorted.map((l, i) => {
              const m = l.materials || {}
              const has = (m.allergens || []).length > 0
              return <span key={i}>{i ? ', ' : ''}{has ? <b>{nameIn(m, lang)}</b> : nameIn(m, lang)}</span>
            })}
          </p>
        )}
        {(wide || !ingredients) && allergenSet.size > 0 && (
          <p className="label-ingr"><span>{T.allergens}: </span><b>{[...allergenSet].join(', ')}</b></p>
        )}
        {!wide && (settings.label_producer || settings.label_address) && (
          <p className="label-producer-line">{T.producer}: {[settings.label_producer, settings.label_address].filter(Boolean).join(', ')}</p>
        )}
        {!wide && settings.label_extra && <p className="label-producer-line">{settings.label_extra}</p>}
      </div>
    </div>
  )
}
