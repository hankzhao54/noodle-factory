import { useT, fmtFt, fmtNum } from '../lib/i18n'
import ImageThumb from './ImageThumb'

// product rows with − / + steppers. items: [{id, name_*, unit, price, min_order_qty, pack_size_g}]
export default function QtyPicker({ items, qty, setQty }) {
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
                {p.price != null ? `${fmtFt(p.price, t.lang)} / ${p.unit}` : p.unit}
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
          </li>
        )
      })}
    </ul>
  )
}

export const cartTotal = (items, qty) =>
  items.reduce((s, p) => s + (qty[p.id] || 0) * Number(p.price || 0), 0)
