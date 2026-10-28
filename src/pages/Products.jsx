import { useState } from 'react'
import CrudPage from '../components/CrudPage'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT, fmtFt, fmtNum } from '../lib/i18n'
import { NumInput, BlurNum, useToast, errText } from '../components/ui'
import { UNITS } from './Materials'

export default function Products() {
  const t = useT()
  const { data: costs, reload } = useData(() => q(db.from('product_cost').select('*')))
  const cost = id => costs?.find(c => c.product_id === id)?.unit_cost
  const margin = r => {
    const c = Number(cost(r.id)); const p = Number(r.base_price)
    return p > 0 && c > 0 ? Math.round((1 - c / p) * 100) + '%' : '–'
  }
  return (
    <CrudPage table="products" title={t('nav_products')} order="sort"
      searchKeys={['name_zh', 'name_en', 'name_hu', 'code']}
      defaults={{ unit: 'kg', active: true, visible_to_customers: true, batch_yield: 1, base_price: 0, min_order_qty: 0, sort: 0 }}
      afterSave={reload}
      columns={[
        { key: 'code', label: t('code') },
        { key: 'name', label: t('name'), render: r => <b>{t.pick(r)}</b> },
        { key: 'unit', label: t('unit'), render: r => r.unit + (r.pack_size_g ? ` · ${r.pack_size_g} g` : '') },
        { key: 'cost', label: t('unitCost'), num: true, render: r => fmtFt(cost(r.id), t.lang) },
        { key: 'base_price', label: t('basePrice'), num: true, render: r => fmtFt(r.base_price, t.lang) },
        { key: 'margin', label: t('margin'), num: true, render: margin },
        { key: 'shelf', label: t('shelfLife'), num: true, render: r => r.shelf_life_days ?? '–' },
      ]}
      fields={[
        { key: 'name_zh', label: t('name_zh'), required: true },
        { key: 'code', label: t('code') },
        { key: 'name_en', label: t('name_en') },
        { key: 'name_hu', label: t('name_hu') },
        { key: 'unit', label: t('unit'), type: 'select', required: true, options: UNITS.map(u => [u, u]) },
        { key: 'pack_size_g', label: t('packSize'), type: 'number' },
        { key: 'batch_yield', label: t('batchYield'), type: 'number', required: true },
        { key: 'base_price', label: t('basePrice'), type: 'number' },
        { key: 'min_order_qty', label: t('minOrder'), type: 'number' },
        { key: 'shelf_life_days', label: t('shelfLife'), type: 'number' },
        { key: 'storage', label: t('storage') },
        { key: 'sort', label: '#', type: 'number' },
        { key: 'description', label: t('description'), type: 'textarea', span: 2 },
        { key: 'visible_to_customers', label: t('visibleToCustomers'), type: 'bool' },
        { key: 'active', label: t('active'), type: 'bool' },
      ]}
      extraFormContent={row => <RecipeEditor product={row} onChange={reload} />} />
  )
}

function RecipeEditor({ product, onChange }) {
  const t = useT()
  const toast = useToast()
  const { data, reload } = useData(async () => {
    const [lines, materials] = await Promise.all([
      q(db.from('recipe_lines').select('*').eq('product_id', product.id).order('sort')),
      q(db.from('materials').select('id,name_zh,name_en,name_hu,unit,cost_per_unit').eq('active', true).order('name_zh')),
    ])
    return { lines, materials }
  }, [product.id])
  const [add, setAdd] = useState({ material_id: '', qty: null })
  if (!data) return null
  const mat = id => data.materials.find(m => m.id === id) || {}
  const batchCost = data.lines.reduce((s, l) => s + l.qty_per_batch * (mat(l.material_id).cost_per_unit || 0), 0)
  const used = new Set(data.lines.map(l => l.material_id))

  const run = async (p) => { try { await q(p); await reload(); onChange?.() } catch (e) { toast(errText(e), 'error') } }

  return (
    <section className="subsection">
      <h3>{t('recipe')} · <span className="muted">{t('recipeFor')} → {fmtNum(product.batch_yield, t.lang)} {product.unit}</span></h3>
      {data.lines.length === 0 ? <p className="muted">{t('noRecipe')}</p> : (
        <table className="table compact">
          <thead><tr><th>{t('nav_materials')}</th><th className="num">{t('qty')}</th><th className="num">{t('total')}</th><th /></tr></thead>
          <tbody>
            {data.lines.map(l => {
              const m = mat(l.material_id)
              return (
                <tr key={l.id}>
                  <td>{t.pick(m)}</td>
                  <td className="num">
                    <BlurNum className="input-sm" value={l.qty_per_batch} aria-label={t('qty')}
                      onCommit={x => x > 0 && run(db.from('recipe_lines').update({ qty_per_batch: x }).eq('id', l.id))} />
                    <span className="unit">{m.unit}</span>
                  </td>
                  <td className="num muted">{fmtFt(l.qty_per_batch * (m.cost_per_unit || 0), t.lang)}</td>
                  <td className="act"><button className="btn-icon" aria-label={t('delete')}
                    onClick={() => run(db.from('recipe_lines').delete().eq('id', l.id))}>×</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <form className="inline-add" onSubmit={e => {
        e.preventDefault(); if (!add.material_id || !(add.qty > 0)) return
        run(db.from('recipe_lines').insert({ product_id: product.id, material_id: add.material_id, qty_per_batch: add.qty, sort: data.lines.length }))
        setAdd({ material_id: '', qty: null })
      }}>
        <select value={add.material_id} onChange={e => setAdd({ ...add, material_id: e.target.value })} aria-label={t('nav_materials')}>
          <option value="">{t('addIngredient')}…</option>
          {data.materials.filter(m => !used.has(m.id)).map(m => <option key={m.id} value={m.id}>{t.pick(m)} ({m.unit})</option>)}
        </select>
        <NumInput className="input-sm" placeholder={t('qty')} value={add.qty} onChange={x => setAdd({ ...add, qty: x })} />
        <button className="btn">{t('add')}</button>
      </form>
      <dl className="cost-line">
        <div><dt>{t('batchCost')}</dt><dd>{fmtFt(batchCost, t.lang)}</dd></div>
        <div><dt>{t('unitCost')}</dt><dd>{fmtFt(product.batch_yield ? batchCost / product.batch_yield : 0, t.lang)} / {product.unit}</dd></div>
      </dl>
    </section>
  )
}
