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
  hu: { id: 'Azon', recorder: 'Rögzítő', producedAt: 'Gyártás időp.', packed: 'Csomagolva', qty: 'Mennyiség', units: { g: 'gramm', kg: 'kg', pcs: 'darab' }, produced: 'Gyártva', useBy: 'Fogyasztható', lot: 'Tétel', storage: 'Tárolás', net: 'Nettó tömeg', allergens: 'Allergének', ingredients: 'Összetevők', producer: 'Gyártó' },
  en: { id: 'ID', recorder: 'Recorded by', producedAt: 'Produced', packed: 'Packed', qty: 'Quantity', units: { g: 'g', kg: 'kg', pcs: 'pcs' }, produced: 'Produced', useBy: 'Use by', lot: 'Lot', storage: 'Storage', net: 'Net weight', allergens: 'Allergens', ingredients: 'Ingredients', producer: 'Producer' },
  zh: { id: '编号', recorder: '记录人', producedAt: '生产时间', packed: '包装日期', qty: '数量', units: { g: '克', kg: '公斤', pcs: '个' }, produced: '生产日期', useBy: '保质期至', lot: '批号', storage: '储存', net: '净含量', allergens: '过敏原', ingredients: '配料', producer: '生产商' },
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
// quantity on labels: kg with at most one decimal, rounded down so the label never overstates
// (51,605 kg → 51,6 kg); under 1 kg it is shown in grams (0,25 kg → 250 g). Returns number + unit.
export function fmtLabelQty(n, unit, units = {}) {
  const v = Number(n) || 0
  const u = x => units[x] || x
  if ((unit === 'kg' || unit === 'l') && v > 0 && v < 1) return `${fmtNum(Math.floor(v * 1000 + 1e-6), 'hu', 0)} ${u(unit === 'kg' ? 'g' : 'ml')}`
  if (unit === 'kg' || unit === 'l') return `${fmtNum(Math.floor(v * 10 + 1e-6) / 10, 'hu', 1)} ${u(unit)}`
  if (['g', 'ml', 'pcs', 'db'].includes(unit)) return `${fmtNum(Math.floor(v + 1e-6), 'hu', 0)} ${u(unit)}`
  return `${fmtNum(v, 'hu', 2)} ${u(unit || '')}`.trim()
}

export function allergenName(raw, lang) {
  const k = String(raw).trim().toLowerCase()
  for (const [key, names] of Object.entries(ALLERGEN)) {
    if (key === k || names.some(n => n.toLowerCase() === k)) return names[LI[lang]]
  }
  return raw
}
// rough weight for ordering the ingredient list (heaviest first)
const KG = { kg: 1, g: 0.001, l: 1, ml: 0.001 }
const toKg = l => Number(l.qty_per_batch) * (KG[l.materials?.unit] ?? 1)
// shelf life in days: the product's own value, else the default from Címke beállítások
export function shelfDays(product, settings) {
  if (product?.shelf_life_days != null && product.shelf_life_days !== '') return Number(product.shelf_life_days)
  const d = settings?.label_default_shelf_days
  return d !== undefined && d !== null && d !== '' && !isNaN(Number(d)) ? Number(d) : null
}
// calendar days, so the clock time stays the same across summer/winter time changes
const addDays = (from, days) => {
  if (!from || days == null) return null
  const d = new Date(from); d.setDate(d.getDate() + days); return d
}
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

// One paper setting for every label (batch labels, pack labels, goods-in labels), so all labels
// come out the same height and the printer's paper never has to be changed between jobs.
const PAPER_KEY = 'nf-label-paper'
const PAPER_FIELDS = ['size', 'length', 'cw', 'ch', 'margin', 'marginImg', 'font']
// margin: blank border kept clear of text, because the printer cannot print right up to the edge
// margin: for PDFs (computer, or "share as PDF" on the phone); marginImg: for label images printed from the
// phone, where iOS adds its own white border, so none by default
export const PAPER_DEFAULT = { size: 'dk22205', length: 31.5, cw: 62, ch: 31.5, margin: 3, marginImg: 0, font: 'barlow' }
export const paperMargin = (kind, paper = readPaper()) => kind === 'image' ? paper.marginImg : paper.margin
export function readPaper() {
  const saved = read(PAPER_KEY, {})
  const p = { ...PAPER_DEFAULT, ...saved }
  // before Nov 2026 there was one margin; a phone that had set it to ~0 for images keeps 3 mm for PDFs
  if (!('marginImg' in saved) && saved.margin != null && Number(saved.margin) < 1) { p.marginImg = Number(saved.margin); p.margin = 3 }
  return Object.fromEntries(PAPER_FIELDS.map(k => [k, p[k]]))
}
export function writePaper(opt) {
  const cur = readPaper()
  const next = Object.fromEntries(PAPER_FIELDS.map(k => [k, k in opt ? opt[k] : cur[k]]))
  write(PAPER_KEY, next)
}

export function traceUrl(lot) {
  return `${window.location.origin}/trace/${encodeURIComponent(lot)}`
}

// sampleProductId: print a test label for that product (no batch, nothing is saved)
// pack: packing labels from the Packing labels page — the batch's lot with a pack number (261123-30/P01),
// the batch's own production and use-by dates, a "packed" date; every print run is recorded (reserve_pack_labels)
export default function LabelPrint({ batchId, sampleProductId, onClose, pack = false, onPrinted }) {
  const t = useT()
  const toast = useToast()
  const { isAdmin, profile } = useAuth()
  // 62 × 31.5 mm matches the "62mm x 31.5mm" paper in the Brother QL driver, so the PC needs no custom paper size
  const [opt, setOpt] = useState(() => {
    const saved = read('nf-label-v3', {})
    if (Number(saved.length) === 32) saved.length = 31.5       // old default
    return { size: 'dk22205', length: 31.5, lang: 'hu', ingredients: true, cw: 62, ch: 31.5, template: 'simple', showQr: false,
             showStorage: true, showProducer: true, ...saved, ...readPaper() }
  })
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
  const [packNote, setPackNote] = useState('')
  const packs = useData(() => pack && batchId ? q(db.from('pack_labels').select('*').eq('batch_id', batchId).order('printed_at')) : Promise.resolve([]), [pack, batchId])
  const nextSeq = (packs.data || []).reduce((m, x) => Math.max(m, x.seq_to), 0) + 1
  const packId = n => `${data?.batch.lot_no || ''}/P${String(n).padStart(2, '0')}`
  const set = patch => setOpt(o => { const n = { ...o, ...patch }; write('nf-label-v3', n); writePaper(n); return n })

  const { data, error } = useData(async () => {
    const now = new Date()
    const batch = batchId
      ? await q(db.from('production_batches').select('*').eq('id', batchId).single())
      : { id: null, no: 0, product_id: sampleProductId, batches: 1, status: 'done', actual_qty: null, done_at: now.toISOString(),
          lot_no: `TEST-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` }
    const [product, lines, cfg, out] = await Promise.all([
      q(db.from('products').select('*').eq('id', batch.product_id).single()),
      q(db.from('recipe_lines').select('qty_per_batch, materials(name_zh,name_en,name_hu,unit,allergens,on_label)').eq('product_id', batch.product_id)),
      q(db.from('settings').select('key,value')),
      batchId ? q(db.from('stock_movements').select('expiry_date').eq('ref_id', batchId).eq('reason', 'production_out').limit(1)) : Promise.resolve([]),
    ])
    return { batch, product, lines, cfg: Object.fromEntries(cfg.map(r => [r.key, r.value || ''])), expiry: out[0]?.expiry_date }
  }, [batchId, sampleProductId])

  useEffect(() => { if (data && !settings) setSettings(data.cfg) }, [data, settings])
  // default quantity per label, in kg: the product's preset (Címke beállítások),
  // else the general default, else the portion size, else the whole batch
  useEffect(() => {
    if (!data || amount !== null) return
    const p = data.product, cfg = data.cfg
    const num = v => (v !== null && v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : null)
    const kg = num(p.label_qty_kg) ?? num(cfg.label_default_qty_kg)
      ?? (p.pack_size_g ? Number(p.pack_size_g) / 1000 : null) ?? (Number(data.batch.actual_qty) || 1)
    setAmount(kg >= 1 ? Math.floor(kg * 10 + 1e-6) / 10 : kg); setUnit('kg')
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

  // rotate a label canvas 90° clockwise (for printers/phones that feed the roll portrait)
  function rotated(c) {
    const r = document.createElement('canvas')
    r.width = c.height; r.height = c.width
    const g = r.getContext('2d')
    g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(c, 0, 0)
    return r
  }

  function printSimple(ids = idFor) {
    try {
      const rot = false
      const pw = w, ph = h
      const orient = pw > ph ? 'landscape' : 'portrait'
      const pdf = new jsPDF({ unit: 'mm', format: [pw, ph], orientation: orient, compress: true })
      for (let i = 0; i < Math.min(copies, 200); i++) {
        if (i) pdf.addPage([pw, ph], orient)
        let c = drawSimpleLabel({ ...label, margin: opt.margin, labelId: ids(i) })
        if (rot) c = rotated(c)
        pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, 0, pw, ph, undefined, 'FAST')
      }
      deliverPdf(pdf.output('blob'))
    } catch (e) { toast(errText(e), 'error') }
  }

  // PNG images, one per label: for Brother iPrint&Label or other label apps
  async function shareImages(ids = idFor) {
    try {
      const files = []
      for (let i = 0; i < Math.min(copies, 50); i++) {
        const c = drawSimpleLabel({ ...label, margin: opt.marginImg, labelId: ids(i) })
        const blob = await withDpi(await new Promise(r => c.toBlob(r, 'image/png')), DPI)
        files.push(new File([blob], `label-${ids(i).replace(/\//g, '-')}.png`, { type: 'image/png' }))
      }
      if (navigator.canShare?.({ files })) await navigator.share({ files })
      else {
        files.forEach(f => {
          const a = document.createElement('a')
          a.href = URL.createObjectURL(f); a.download = f.name; a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 5000)
        })
      }
    } catch (e) { if (e?.name !== 'AbortError') toast(errText(e), 'error') }
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

  const simple = pack || opt.template === 'simple'
  const label = { ...data, lot, qr, settings, lang: opt.lang, ingredients: opt.ingredients, w, h, packedAt: pack ? new Date() : null,
                  simple, recorder, amount, unit, showQr: !!opt.showQr, margin: touch ? opt.marginImg : opt.margin, font: opt.font,
                  showStorage: opt.showStorage !== false, showProducer: opt.showProducer !== false, showNutrition: !!opt.showNutrition }
  const idFor = i => pack ? packId(nextSeq + i) : copies > 1 ? `${lot}-${String(i + 1).padStart(2, '0')}` : lot
  // packing labels: reserve the pack numbers first (recorded), then print with exactly those numbers
  async function packPrint(fn) {
    try {
      const from = await q(db.rpc('reserve_pack_labels', { p_batch: batchId, p_labels: Math.min(copies, 200), p_qty: amount, p_unit: unit, p_note: packNote || null }))
      await fn(i => packId(from + i))
      packs.reload(); onPrinted?.()
    } catch (e) { toast(errText(e), 'error') }
  }
  const prevPacks = packs.data || []
  const prevLabels = prevPacks.reduce((a, x) => a + x.labels, 0)
  const prevKg = prevPacks.reduce((a, x) => a + (x.unit === 'kg' ? x.labels * Number(x.qty_per_label || 0) : x.unit === 'g' ? x.labels * Number(x.qty_per_label || 0) / 1000 : 0), 0)
  const scale = Math.min(1.8, 300 / w)

  return (
    <Modal wide title={`${pack ? t('packLabels') : t('printLabels')} · ${t.pick(data.product)} · ${lot}`} onClose={onClose}>
      {pack && prevPacks.length > 0 && (
        <div className="note-box short-box">
          ⚠ {t('packedBefore', { n: prevPacks.length, l: prevLabels, kg: fmtNum(Math.round(prevKg * 10) / 10, t.lang) })}
          <ul className="pack-history">{prevPacks.map(x => (
            <li key={x.id}>{new Date(x.printed_at).toLocaleString(t.lang === 'zh' ? 'zh-CN' : t.lang === 'en' ? 'en-GB' : 'hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {' · '}{packId(x.seq_from)}{x.seq_to > x.seq_from ? ` – P${String(x.seq_to).padStart(2, '0')}` : ''}
              {' · '}{x.labels} × {fmtLabelQty(x.qty_per_label, x.unit)}{x.printed_by_name ? ` · ${x.printed_by_name}` : ''}{x.note ? ` · ${x.note}` : ''}</li>
          ))}</ul>
        </div>
      )}
      <div className="label-layout">
        <div className="stack">
          {!pack && <Field label={t('labelTemplate')}>
            <select value={opt.template} onChange={e => set({ template: e.target.value })}>
              <option value="simple">{t('templateSimple')}</option>
              <option value="full">{t('templateFull')}</option>
            </select>
          </Field>}
          <Field label={t('labelSize')}>
            <select value={opt.size} onChange={e => set({ size: e.target.value })}>
              {LABEL_SIZES.map(s => <option key={s.id} value={s.id}>{s.custom ? t('customSize') : s.name}</option>)}
            </select>
          </Field>
          {size.cont && <Field label={t('labelLength')} hint={t('paperShared')}><NumInput value={opt.length} min={20} max={300} onChange={v => set({ length: v })} /></Field>}
          <LabelPaperExtras opt={opt} set={set} t={t} />
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
            <label className="check-inline"><input type="checkbox" checked={!!opt.showQr} onChange={e => set({ showQr: e.target.checked })} />{t('showQr')}</label>
            <label className="check-inline"><input type="checkbox" checked={opt.showStorage !== false} onChange={e => set({ showStorage: e.target.checked })} />{t('showStorage')}
              {!data.product.storage && <span className="tag tag-low">{t('missing')}</span>}</label>
            <label className="check-inline"><input type="checkbox" checked={opt.showProducer !== false} onChange={e => set({ showProducer: e.target.checked })} />{t('showProducer')}</label>
            <label className="check-inline"><input type="checkbox" checked={!!opt.showNutrition} onChange={e => set({ showNutrition: e.target.checked })} />{t('showNutrition')}
              {data.product.nut_kj == null && <span className="tag tag-low">{t('missing')}</span>}</label>
            <Field label={t('recorder')}><input value={recorder} onChange={e => setRecorder(e.target.value)} /></Field>
            <p className="muted small">
              {t('useByFrom', { n: shelfDays(data.product, settings) ?? '–' })}{' '}
              <a href="/label-settings">{t('nav_labelSettings')}</a>
            </p>
            <Field label={t('qtyPerLabel')}>
              <div className="row-gap nowrap">
                <NumInput value={amount} min={0} onChange={setAmount} style={{ flex: 1 }} />
                <select value={unit} onChange={e => setUnit(e.target.value)} style={{ width: 'auto' }}>
                  <option value="g">gramm</option><option value="kg">kg</option><option value="pcs">darab</option>
                </select>
              </div>
            </Field>
          </> : <label className="check-inline"><input type="checkbox" checked={opt.ingredients} onChange={e => set({ ingredients: e.target.checked })} />{t('showIngredients')}</label>}
          <Field label={t('copies')} hint={copies > 1 || pack ? t('copiesIdHint', { a: idFor(0), b: idFor(Math.max(0, copies - 1)) }) : null}><NumInput value={copies} min={1} max={200} onChange={v => setCopies(v)} /></Field>
          {pack && <Field label={t('packNote')}><input value={packNote} onChange={e => setPackNote(e.target.value)} placeholder={t('packNotePh')} /></Field>}

          {<details className="label-producer">
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
        {!pack && <button className="btn btn-quiet" disabled={!qr || !(copies > 0) || printing} onClick={() => setPrinting(true)}>{t('browserPrint')}</button>}
        {simple && (touch
          ? <button className="btn btn-quiet" disabled={!(copies > 0)} onClick={() => pack ? packPrint(printSimple) : printSimple()}>{t('sharePdf')}</button>
          : <button className="btn btn-quiet" disabled={!(copies > 0)} onClick={() => pack ? packPrint(shareImages) : shareImages()}>{t('shareImage')}</button>)}
        {pdfUrl && <a className="btn btn-quiet" href={pdfUrl} target="_blank" rel="noreferrer">{t('openPdfAgain')}</a>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('close')}</button>
        {simple ? (
          <button className="btn btn-primary" disabled={!(copies > 0) || (pack && packs.loading)} onClick={() => { const fn = touch ? shareImages : printSimple; pack ? packPrint(fn) : fn() }}>{t('print')} × {copies || 0}</button>
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
// label fonts: narrow faces that stay sharp on a 300 dpi thermal head; weights: [regular line, bold line]
export const LABEL_FONTS = {
  barlow:  { name: 'Barlow Semi Condensed', family: '"Barlow Semi Condensed"', w: [600, 700], stretch: false },
  roboto:  { name: 'Roboto Condensed', family: '"Roboto Condensed"', w: [500, 700], stretch: false },
  archivo: { name: 'Archivo (condensed)', family: '"Archivo Variable"', w: [500, 700], stretch: true },
}
const FALLBACK = '"Noto Sans SC", "Helvetica Neue", Helvetica, Arial, sans-serif'
let CUR = LABEL_FONTS.barlow   // the face drawSimpleLabel is drawing with
let FONT = `${CUR.family}, ${FALLBACK}`
// PNG with its print resolution written in (pHYs chunk), so apps that honour it print the label at its real
// size in mm instead of guessing (a canvas PNG carries no resolution, often read as 72 dpi).
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
async function withDpi(blob, dpi) {
  try {
    const src = new Uint8Array(await blob.arrayBuffer())
    const ihdrEnd = 8 + 4 + 4 + 13 + 4                // signature + IHDR (length, type, data, crc)
    const ppm = Math.round(dpi / 0.0254)
    const chunk = new Uint8Array(4 + 4 + 9 + 4), v = new DataView(chunk.buffer)
    v.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4)   // "pHYs"
    v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1     // pixels per metre, unit = metre
    v.setUint32(17, crc32(chunk.subarray(4, 17)))
    const out = new Uint8Array(src.length + chunk.length)
    out.set(src.subarray(0, ihdrEnd)); out.set(chunk, ihdrEnd); out.set(src.subarray(ihdrEnd), ihdrEnd + chunk.length)
    return new Blob([out], { type: 'image/png' })
  } catch { return blob }
}

// Canvas font: weight + size + family only. The condensed width is set separately (ctx.fontStretch):
// iPhone Safari rejects "condensed" inside the font shorthand and silently fell back to 10px sans-serif,
// which made phone-printed labels tiny. Where fontStretch is not supported the text is just a little wider.
function setFont(g, weight, px) {
  const wgt = weight >= 700 ? CUR.w[1] : CUR.w[0]
  g.font = `${wgt} ${px}px ${FONT}`
  if ('fontStretch' in g) g.fontStretch = CUR.stretch ? 'condensed' : 'normal'
}
// 1 when the canvas really draws Archivo condensed, else the factor that imitates it
function condensedSqueeze(g) {
  if (!CUR.stretch) return 1
  const probe = 'Gyártás időp.: 2026.11.25 17:14'
  g.font = `500 40px ${FONT}`
  if ('fontStretch' in g) g.fontStretch = 'normal'
  const normal = g.measureText(probe).width
  setFont(g, 500, 40)
  const narrow = g.measureText(probe).width
  return narrow / normal < 0.95 ? 1 : 0.79
}
// make sure the faces the canvas uses are loaded before drawing
export const labelFontsReady = () => Promise.all(Object.values(LABEL_FONTS).flatMap(f => f.w.map(w => `${w} 40px ${f.family}`)).map(f => document.fonts?.load?.(f, 'ÁŐŰáőű0123') || Promise.resolve())).catch(() => {})

function simpleLines({ product, batch, expiry, settings, lang, recorder, amount, unit, labelId, showStorage, showProducer, packedAt }) {
  const T = L[lang] || L.hu
  const produced = batch.done_at || batch.planned_date
  const useBy = addDays(produced, shelfDays(product, settings)) || expiry
  return [
    { text: nameIn(product, lang), bold: true },
    { text: `${T.id}: ${labelId}` },
    recorder && { text: `${T.recorder}: ${recorder}` },
    { text: `${T.producedAt}: ${ymdhm(produced)}` },
    packedAt && { text: `${T.packed}: ${ymd(packedAt)}` },
    useBy && { text: `${T.useBy}: ${ymdhm(useBy)}` },
    amount > 0 && { text: `${T.qty}: ${fmtLabelQty(amount, unit, T.units)}` },
    showStorage && product.storage && { text: `${T.storage}: ${product.storage}` },
    showProducer && settings?.label_producer && { text: `${T.producer}: ${settings.label_producer}` },
    showProducer && settings?.label_address && { text: settings.label_address },
  ].filter(Boolean)
}

// nutrition declaration per 100 g (EU 1169/2011 order); null when the product has no values
const NUT_T = {
  hu: { head: 'Tápérték / 100 g', energy: 'Energia', fat: 'Zsír', sat: '– ebből telített zsírsavak', carbs: 'Szénhidrát', sugars: '– ebből cukrok', protein: 'Fehérje', salt: 'Só' },
  en: { head: 'Nutrition / 100 g', energy: 'Energy', fat: 'Fat', sat: '– of which saturates', carbs: 'Carbohydrate', sugars: '– of which sugars', protein: 'Protein', salt: 'Salt' },
  zh: { head: '营养成分 / 100 g', energy: '能量', fat: '脂肪', sat: '– 饱和脂肪', carbs: '碳水化合物', sugars: '– 糖', protein: '蛋白质', salt: '盐' },
}
export function nutritionRows(product, lang) {
  if (!product || product.nut_kj == null) return null
  const N = NUT_T[lang] || NUT_T.hu
  const g = v => `${Number(v).toLocaleString(lang === 'hu' ? 'hu-HU' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} g`
  return [
    [N.energy, `${Math.round(product.nut_kj)} kJ`], ['', `${Math.round(product.nut_kcal)} kcal`],
    [N.fat, g(product.nut_fat)], [N.sat, g(product.nut_saturates)],
    [N.carbs, g(product.nut_carbs)], [N.sugars, g(product.nut_sugars)],
    [N.protein, g(product.nut_protein)], [N.salt, g(product.nut_salt)],
  ].map(([k, v]) => ({ k, v }))
}

export function drawSimpleLabel(props) {
  const { w, h, lot } = props
  CUR = LABEL_FONTS[props.font ?? readPaper().font] || LABEL_FONTS.barlow
  FONT = `${CUR.family}, ${FALLBACK}`
  const W = Math.round(w * PX_PER_MM), H = Math.round(h * PX_PER_MM)
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H)
  g.fillStyle = '#000'
  // condensed text: real condensed width where the browser supports it (Chrome), otherwise (iPhone Safari)
  // the same look by squeezing each line horizontally to 79 % (measured: Archivo condensed / normal)
  const sq = condensedSqueeze(g)
  const mw = text => g.measureText(text).width * sq
  const ft = (text, x, y) => {
    if (sq === 1) return g.fillText(text, x, y)
    g.save(); g.translate(x, y); g.scale(sq, 1); g.fillText(text, 0, 0); g.restore()
  }
  const m = Number(props.margin ?? PAPER_DEFAULT.margin)
  const pad = Math.max(0.3, Math.min(8, isNaN(m) ? 3 : m)) * PX_PER_MM, gap = 1.4 * PX_PER_MM

  // QR (optional): whole-pixel modules so it stays sharp on a 300 dpi head
  let x0 = Math.round(pad)
  if (props.showQr && lot) {
    const qr = QRCode.create(traceUrl(lot), { errorCorrectionLevel: 'M' })
    const n = qr.modules.size
    const cell = Math.max(1, Math.floor((Math.min(h * 0.6, w * 0.27, h - 2) * PX_PER_MM) / n))
    const qrPx = cell * n
    const qx = Math.round(pad), qy = Math.round((H - qrPx) / 2)
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
      if (qr.modules.data[r * n + col]) g.fillRect(qx + col * cell, qy + r * cell, cell, cell)
    }
    x0 = qx + qrPx + gap
  }

  // text: the biggest size at which every line fits (condensed face, like the OkoHACCP font).
  // Long lines (storage, address) may wrap onto a second line rather than shrink everything.
  // textLines: [{ text, bold }] given directly (e.g. goods-in labels); otherwise the product label lines
  const lines = props.textLines || simpleLines(props)
  // optional nutrition block on the right, separated by a thin rule
  const nut = !props.textLines && props.showNutrition ? nutritionRows(props.product, props.lang) : null
  const nutHead = nut ? (NUT_T[props.lang] || NUT_T.hu).head : ''
  const total = W - x0 - pad, maxH = H - 2 * pad
  const ruleGap = nut ? gap : 0
  const fontOf = (l, px) => [l.bold ? 700 : 500, l.bold ? px * 1.05 : px]
  const wrap = (text, font, width) => {
    setFont(g, ...font)
    if (mw(text) <= width) return [text]
    const words = text.split(' '), out = []
    let cur = ''
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w
      if (cur && mw(next) > width) { out.push(cur); cur = w } else cur = next
    }
    if (cur) out.push(cur)
    return out.some(l => mw(l) > width) ? null : out
  }
  // lay out at a size: null if it does not fit
  const layout = (px, mainW, nutW) => {
    const lh = px * 1.16
    const main = []
    for (const l of lines) {
      // the name, IDs, dates and quantities never wrap; storage, producer, address etc. may
      const keep = l.bold || /\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}|^\S+:\s*[\d#]|ID:|\d\s*(kg|g|db|pcs)\b/.test(l.text)
      const parts = keep ? (setFont(g, ...fontOf(l, px)), mw(l.text) <= mainW ? [l.text] : null)
                                                           : wrap(l.text, fontOf(l, px), mainW)
      if (!parts) return null
      parts.forEach(t => main.push({ ...l, text: t }))
    }
    if (main.length * lh > maxH) return null
    const rows = []
    if (nut) {
      setFont(g, 700, px)
      if (mw(nutHead) > nutW) return null
      const f = [500, px]
      for (const r of nut) {
        setFont(g, ...f)
        const vw = mw(r.v)
        const ks = r.k ? wrap(r.k, f, nutW - vw - px * 0.5) : ['']
        if (!ks) return null
        ks.forEach((k, i) => rows.push({ k, v: i === ks.length - 1 ? r.v : '' }))
      }
      if ((rows.length + 1) * lh > maxH) return null
    }
    return { px, lh, main, rows }
  }
  const fitAt = (mainW, nutW) => {
    for (let p = 24; p >= 4.5; p = Math.round((p - 0.2) * 10) / 10) {
      const r = layout(p * DPI / 72, mainW, nutW)
      if (r) return r
    }
    return layout(4.5 * DPI / 72, mainW, nutW) || { px: 4.5 * DPI / 72, lh: 4.5 * DPI / 72 * 1.16, main: lines, rows: nut || [] }
  }
  let L0, mainW = total, nutW = 0
  if (nut) {
    // split the width between the two blocks so the text can be as big as possible
    for (let f = 0.30; f <= 0.601; f += 0.02) {
      const nw = total * f, mw = total - nw - ruleGap * 2
      const r = fitAt(mw, nw)
      if (!L0 || r.px > L0.px) { L0 = r; mainW = mw; nutW = nw }
    }
  } else L0 = fitAt(mainW, 0)
  const { px, lh, main, rows } = L0
  g.textBaseline = 'middle'
  let y = (H - main.length * lh) / 2 + lh / 2
  for (const l of main) { setFont(g, ...fontOf(l, px)); ft(l.text, x0, y); y += lh }
  if (nut) {
    const nx = x0 + mainW + ruleGap * 2, rx = W - pad
    g.fillRect(Math.round(x0 + mainW + ruleGap), Math.round(pad), Math.max(1, Math.round(PX_PER_MM * 0.15)), Math.round(maxH))
    let ny = (H - (rows.length + 1) * lh) / 2 + lh / 2
    setFont(g, 700, px); g.textAlign = 'left'; ft(nutHead, nx, ny); ny += lh
    setFont(g, 500, px)
    for (const r of rows) {
      g.textAlign = 'left'; ft(r.k, nx, ny)
      if (r.v) { g.textAlign = 'right'; ft(r.v, rx, ny) }
      ny += lh
    }
    g.textAlign = 'left'
  }
  // thermal printers print only black or white: turn the anti-aliased grey edges into pure black/white,
  // so letters stay sharp instead of being dithered (and blurred further when the phone rescales the image)
  const img = g.getImageData(0, 0, W, H), bits = img.data
  for (let i = 0; i < bits.length; i += 4) {
    const v = bits[i] * 0.299 + bits[i + 1] * 0.587 + bits[i + 2] * 0.114 < 165 ? 0 : 255
    bits[i] = bits[i + 1] = bits[i + 2] = v; bits[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c
}

function CanvasPreview(props) {
  const [src, setSrc] = useState('')
  const [fontTick, setFontTick] = useState(0)
  useEffect(() => { labelFontsReady().then(() => setFontTick(x => x + 1)) }, [])
  const key = JSON.stringify([props.w, props.h, props.lot, props.lang, props.recorder, props.amount, props.unit, props.labelId, props.showQr, props.showStorage, props.showProducer, props.showNutrition, props.margin, props.settings?.label_producer, props.settings?.label_address, fontTick])
  useEffect(() => { setSrc(drawSimpleLabel(props).toDataURL('image/png')) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return <img src={src} alt="" style={{ width: '100%', height: 'auto', display: 'block' }} />
}

/* same layout as the OkoHACCP labels: QR left, six lines right */
function SimpleLabel({ product, batch, expiry, settings, qr, lang, w, h, recorder, amount, unit, labelId, measure, fitPt, onFit }) {
  const T = L[lang] || L.hu
  const produced = batch.done_at || batch.planned_date
  const useBy = addDays(produced, shelfDays(product, settings)) || expiry
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
        {amount > 0 && <span>{T.qty}: {fmtLabelQty(amount, unit, T.units)}</span>}
      </div>
    </div>
  )
}

function FullLabel({ product, lines, batch, expiry, lot, qr, settings, lang, ingredients, w, h }) {
  const T = L[lang] || L.hu
  const wide = w / h > 2.2 || h < 35   // short labels (29×90, 62×29): compact, allergens only
  const produced = batch.done_at || batch.planned_date
  const useBy = addDays(produced, shelfDays(product, settings)) || expiry

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

// shared paper fields: two margins (PDF / phone image) and the font
export function LabelPaperExtras({ opt, set, t }) {
  return <>
    <div className="row-gap">
      <Field label={t('labelMarginPdf')} hint={t('labelMarginHint')}><NumInput value={opt.margin} min={0} max={8} onChange={v => set({ margin: v })} /></Field>
      <Field label={t('labelMarginImg')}><NumInput value={opt.marginImg} min={0} max={8} onChange={v => set({ marginImg: v })} /></Field>
    </div>
    <Field label={t('labelFont')}>
      <select value={opt.font} onChange={e => set({ font: e.target.value })}>
        {Object.entries(LABEL_FONTS).map(([k, f]) => <option key={k} value={k}>{f.name}</option>)}
      </select>
    </Field>
  </>
}
