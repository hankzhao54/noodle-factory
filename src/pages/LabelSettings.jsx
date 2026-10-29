import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtNum } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, BlurNum, useToast, errText } from '../components/ui'

// Presets for label printing: shelf life and default quantity per label (kg), per product,
// plus general defaults used when a product has no value.
export default function LabelSettings() {
  const t = useT()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const { data, error, reload } = useData(async () => {
    const [products, cfg] = await Promise.all([
      q(db.from('products').select('id,code,name_zh,name_en,name_hu,unit,shelf_life_days,label_qty_kg,active,sort').eq('active', true).order('sort')),
      q(db.from('settings').select('key,value').in('key', ['label_default_shelf_days', 'label_default_qty_kg'])),
    ])
    return { products, cfg: Object.fromEntries(cfg.map(r => [r.key, r.value])) }
  })

  const save = async (promise) => {
    try { await q(promise); toast(t('saved')); reload() } catch (e) { toast(errText(e), 'error') }
  }
  const setProduct = (id, patch) => save(db.from('products').update(patch).eq('id', id))
  const setDefault = (key, value) => save(db.from('settings').upsert({ key, value: value == null ? '' : String(value), updated_at: new Date().toISOString() }))
  const num = v => (v === '' || v == null ? null : Number(v))

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data) return <div className="page"><Loading /></div>
  const defShelf = num(data.cfg.label_default_shelf_days)
  const defQty = num(data.cfg.label_default_qty_kg)

  return (
    <div className="page">
      <PageHead title={t('nav_labelSettings')} />
      <p className="muted lead">{t('lsIntro')}</p>

      <section className="panel">
        <div className="panel-head"><h2>{t('lsDefaults')}</h2>{!isAdmin && <span className="muted small">{t('lsAdminOnly')}</span>}</div>
        <div className="form-grid pad">
          <label className="field"><span className="field-label">{t('lsShelf')}</span>
            <BlurNum value={defShelf} min={0} disabled={!isAdmin} onCommit={v => setDefault('label_default_shelf_days', v)} /></label>
          <label className="field"><span className="field-label">{t('lsQty')}</span>
            <BlurNum value={defQty} min={0} disabled={!isAdmin} onCommit={v => setDefault('label_default_qty_kg', v)} /></label>
        </div>
      </section>

      <div className="table-wrap"><table className="table">
        <thead><tr><th>{t('code')}</th><th>{t('name')}</th><th className="num">{t('lsShelf')}</th><th className="num">{t('lsQty')}</th></tr></thead>
        <tbody>{data.products.map(p => (
          <tr key={p.id}>
            <td className="muted">{p.code || '–'}</td>
            <td><b>{t.pick(p)}</b></td>
            <td className="num">
              <BlurNum className="input-sm" value={p.shelf_life_days} min={0} placeholder={defShelf != null ? String(defShelf) : ''}
                aria-label={`${t.pick(p)} ${t('lsShelf')}`} onCommit={v => setProduct(p.id, { shelf_life_days: v == null ? null : Math.round(v) })} />
              {p.shelf_life_days == null && defShelf != null && <div className="muted small">{t('lsUsesDefault')}: {fmtNum(defShelf, t.lang)}</div>}
            </td>
            <td className="num">
              <BlurNum className="input-sm" value={p.label_qty_kg} min={0} placeholder={defQty != null ? String(defQty) : ''}
                aria-label={`${t.pick(p)} ${t('lsQty')}`} onCommit={v => setProduct(p.id, { label_qty_kg: v })} />
              {p.label_qty_kg == null && defQty != null && <div className="muted small">{t('lsUsesDefault')}: {fmtNum(defQty, t.lang)}</div>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  )
}
