import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
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
  hu: { produced: 'Gyártva', useBy: 'Fogyasztható', lot: 'Tétel', storage: 'Tárolás', net: 'Nettó tömeg', allergens: 'Allergének', ingredients: 'Összetevők', producer: 'Gyártó' },
  en: { produced: 'Produced', useBy: 'Use by', lot: 'Lot', storage: 'Storage', net: 'Net weight', allergens: 'Allergens', ingredients: 'Ingredients', producer: 'Producer' },
  zh: { produced: '生产日期', useBy: '保质期至', lot: '批号', storage: '储存', net: '净含量', allergens: '过敏原', ingredients: '配料', producer: '生产商' },
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
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } }

export function traceUrl(lot) {
  return `${window.location.origin}/trace/${encodeURIComponent(lot)}`
}

export default function LabelPrint({ batchId, onClose }) {
  const t = useT()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const [opt, setOpt] = useState(() => read('nf-label', { size: 'dk22205', length: 50, lang: 'hu', ingredients: true, cw: 62, ch: 50 }))
  const [copies, setCopies] = useState(1)
  const [printing, setPrinting] = useState(false)
  const [qr, setQr] = useState('')
  const [settings, setSettings] = useState(null)
  const set = patch => setOpt(o => { const n = { ...o, ...patch }; write('nf-label', n); return n })

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
    const id = setTimeout(() => { window.print(); style.remove(); setPrinting(false) }, 80)
    return () => { clearTimeout(id); style.remove() }
  }, [printing, w, h])

  async function saveSettings() {
    try {
      await q(db.from('settings').upsert(Object.entries(settings).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }))))
      toast(t('saved'))
    } catch (e) { toast(errText(e), 'error') }
  }

  if (error) return <Modal title={t('printLabels')} onClose={onClose}><p className="error-box">{errText(error)}</p></Modal>
  if (!data || !settings) return <Modal title={t('printLabels')} onClose={onClose}><Loading /></Modal>

  const label = { ...data, lot, qr, settings, lang: opt.lang, ingredients: opt.ingredients, w, h }
  const scale = Math.min(1.8, 300 / w)

  return (
    <Modal wide title={`${t('printLabels')} · ${t.pick(data.product)} · ${lot}`} onClose={onClose}>
      <div className="label-layout">
        <div className="stack">
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
          <label className="check-inline"><input type="checkbox" checked={opt.ingredients} onChange={e => set({ ingredients: e.target.checked })} />{t('showIngredients')}</label>
          <Field label={t('copies')}><NumInput value={copies} min={1} max={200} onChange={v => setCopies(v)} /></Field>

          <details className="label-producer">
            <summary>{t('producerInfo')}{!settings.label_producer && <span className="tag tag-low">{t('missing')}</span>}</summary>
            <Field label={t('producerName')}><input value={settings.label_producer} disabled={!isAdmin} onChange={e => setSettings(s => ({ ...s, label_producer: e.target.value }))} /></Field>
            <Field label={t('producerAddress')}><input value={settings.label_address} disabled={!isAdmin} onChange={e => setSettings(s => ({ ...s, label_address: e.target.value }))} /></Field>
            <Field label={t('labelExtra')}><input value={settings.label_extra} disabled={!isAdmin} onChange={e => setSettings(s => ({ ...s, label_extra: e.target.value }))} /></Field>
            {isAdmin && <button className="btn btn-sm" onClick={saveSettings}>{t('saveForAll')}</button>}
          </details>
        </div>

        <div className="label-preview-wrap">
          <p className="muted small">{t('labelPreview')} · {w} × {h} mm</p>
          <div className="label-preview" style={{ width: `${w * scale}mm`, height: `${h * scale}mm` }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              <Label {...label} />
            </div>
          </div>
          <p className="muted small label-hint">{t('labelHint')}</p>
        </div>
      </div>

      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('close')}</button>
        <button className="btn btn-primary" disabled={!qr || !(copies > 0)} onClick={() => setPrinting(true)}>
          {t('print')} × {copies || 0}
        </button>
      </div>

      {printing && createPortal(
        <div className="print-only label-print">
          {Array.from({ length: Math.min(copies, 200) }).map((_, i) => <Label key={i} {...label} />)}
        </div>, document.body)}
    </Modal>
  )
}

/* one label, sized in mm; layout adapts to the shape */
export function Label({ product, lines, batch, expiry, lot, qr, settings, lang, ingredients, w, h }) {
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
