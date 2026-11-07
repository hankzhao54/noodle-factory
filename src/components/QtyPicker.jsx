import { useT, fmtFt, fmtNum } from '../lib/i18n'
import ImageThumb from './ImageThumb'
import { allergenName } from './LabelPrint'

// product rows with − / + steppers. items: [{id, name_*, unit, price, min_order_qty, pack_size_g}]
// info: product_info() map (portal) → each row gets a "Product information" section
export default function QtyPicker({ items, qty, setQty, info, producer }) {
  // only show the photo column when at least one product has a photo
  const withPhotos = items.some(p => p.image_path)
  const t = useT()
  const set = (id, v) => setQty(s => {
    const n = { ...s }
    if (!v || v <= 0) delete n[id]; else n[id] = Math.round(v * 1000) / 1000
    return n
  })
  return (
    <ul className="qty-list">
      {items.map(p => {
        const v = qty[p.id] || 0
        const step = p.unit === 'kg' ? 1 : 1
        const min = Number(p.min_order_qty) || 0
        return (
          <li key={p.id} className={v ? 'has-qty' : ''}>
            {withPhotos && <ImageThumb path={p.image_path} size={52} />}
            <div className="qty-info">
              <span className="qty-name">{t.pick(p)}</span>
              <span className="qty-meta">
                {p.price != null ? `${fmtFt(p.price, t.lang)} ${t('netPrice')} / ${p.unit}` : p.unit}
                {p.pack_size_g ? ` · ${p.pack_size_g} g` : ''}
                {min > 0 ? ` · ${t('minOrderNote')} ${fmtNum(min, t.lang)}` : ''}
              </span>
            </div>
            <div className="stepper">
              <button type="button" aria-label="−" disabled={!v} onClick={() => set(p.id, v - step < min ? 0 : v - step)}>−</button>
              <input type="number" inputMode="decimal" step="any" min="0" aria-label={`${t.pick(p)} ${t('qty')}`}
                value={v || ''} placeholder="0" onChange={e => set(p.id, Number(e.target.value))} />
              <button type="button" aria-label="+" onClick={() => set(p.id, Math.max(v + step, min))}>+</button>
              <span className="unit">{p.unit}</span>
            </div>
            {info?.[p.id] && <ProductInfo pi={info[p.id]} producer={producer} />}
          </li>
        )
      })}
    </ul>
  )
}

export const cartTotal = (items, qty) =>
  items.reduce((s, p) => s + (qty[p.id] || 0) * Number(p.price || 0), 0)

function ProductInfo({ pi, producer }) {
  const t = useT()
  const lang = ['hu', 'en', 'zh'].includes(t.lang) ? t.lang : 'hu'
  const net = pi.label_qty_kg ? `${fmtNum(pi.label_qty_kg, t.lang, 3)} kg` : pi.pack_size_g ? `${pi.pack_size_g} g` : null
  return (
    <details className="prod-info">
      <summary>{t('productInfo')}</summary>
      <dl>
        <dt>{t('ingredientsL')}</dt>
        <dd>{pi.ingredients.length ? pi.ingredients.map((x, i) => (
          <span key={i}>{i ? ', ' : ''}{x.allergen ? <b>{x[lang] || x.hu}</b> : (x[lang] || x.hu)}</span>)) : '–'}</dd>
        <dt>{t('allergens')}</dt>
        <dd>{pi.allergens.length ? <b>{pi.allergens.map(a => allergenName(a, lang)).join(', ')}</b> : '–'}</dd>
        {net && <><dt>{t('netQty')}</dt><dd>{net}</dd></>}
        <dt>{t('storage')}</dt><dd>{pi.storage || '–'}</dd>
        {pi.shelf_life_days != null && <><dt>{t('shelfLifeL')}</dt><dd>{t('daysFromProduction', { n: pi.shelf_life_days })}</dd></>}
        {producer && <><dt>{t('producerL')}</dt><dd>{producer}</dd></>}
      </dl>
      {pi.description && <p className="muted small">{pi.description}</p>}
    </details>
  )
}
