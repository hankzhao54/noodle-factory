import CrudPage from '../components/CrudPage'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtNum, fmtFt, categoryOptions } from '../lib/i18n'

export const UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'pack', 'box']

export default function Materials() {
  const t = useT()
  const { data: suppliers } = useData(() => q(db.from('suppliers').select('id,name').eq('active', true).order('name')))
  const supName = id => suppliers?.find(s => s.id === id)?.name || '–'
  return (
    <>
    <datalist id="material-categories">{categoryOptions(t.lang).map(c => <option key={c} value={c} />)}</datalist>
    <CrudPage table="materials" title={t('nav_materials')} order="name_zh" imageFolder="materials"
      searchKeys={['name_zh', 'name_en', 'name_hu', 'code', 'category']}
      defaults={{ unit: 'kg', active: true, min_stock: 0, cost_per_unit: 0, on_label: true, track_stock: true }}
      columns={[
        { key: 'code', label: t('code') },
        { key: 'name', label: t('name'), render: r => <b>{t.pick(r)}</b> },
        { key: 'category', label: t('category'), render: r => t.cat(r.category) || '–' },
        { key: 'unit', label: t('unit') },
        { key: 'cost_per_unit', label: t('costPerUnit'), num: true, render: r => <>{fmtFt(r.cost_per_unit, t.lang)} <span className="muted">/ {r.unit}</span></> },
        { key: 'pack_size', label: t('packPrice'), num: true, render: r => Number(r.pack_size) > 0
          ? <>{fmtFt(Math.round(r.cost_per_unit * r.pack_size), t.lang)} <span className="muted">/ {fmtNum(r.pack_size, t.lang)} {r.unit}</span></> : <span className="muted">–</span> },
        { key: 'min_stock', label: t('minStock'), num: true, render: r => fmtNum(r.min_stock, t.lang) },
        { key: 'sup', label: t('defaultSupplier'), render: r => supName(r.default_supplier_id) },
      ]}
      fields={[
        { key: 'name_zh', label: t('name_zh'), required: true },
        { key: 'code', label: t('code') },
        { key: 'name_en', label: t('name_en') },
        { key: 'name_hu', label: t('name_hu') },
        { key: 'category', label: t('category'), list: 'material-categories', hint: t('categoryHint'), display: t.cat },
        { key: 'unit', label: t('unit'), type: 'select', required: true, options: UNITS.map(u => [u, u]) },
        { key: 'pack_size', label: t('packSizeField'), type: 'number', hint: t('packSizeHint') },
        { key: 'cost_per_unit', label: t('costPerUnit'), type: 'number', hint: t('costPerUnitHint') },
        { key: 'min_stock', label: t('minStock'), type: 'number' },
        { key: 'default_supplier_id', label: t('defaultSupplier'), type: 'select', options: (suppliers || []).map(s => [s.id, s.name]) },
        { key: 'allergens', label: t('allergens'), type: 'tags', hint: t('allergensHint') },
        { key: 'ingredient_hu', label: t('ingredientHu'), hint: t('ingredientHint') },
        { key: 'ingredient_en', label: t('ingredientEn') },
        { key: 'ingredient_zh', label: t('ingredientZh') },
        { key: 'on_label', label: t('onLabel'), type: 'bool' },
        { key: 'track_stock', label: t('trackStock'), type: 'bool', hint: t('trackStockHint') },
        { key: 'active', label: t('active'), type: 'bool' },
      ]} />
    </>
  )
}
