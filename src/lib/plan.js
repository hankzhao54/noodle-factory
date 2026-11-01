// Production plan shared by the dashboard and the production page.
// demand = open orders (submitted/confirmed) due on or before the date
// toMake = demand − finished stock − already planned batches; suggest = batches to add

export function buildPlan({ products, demand, pstock, batches }) {
  const open = batches.filter(b => b.status === 'planned')
  return products.map(p => {
    const d = demand.filter(x => x.product_id === p.id).reduce((s, x) => s + Number(x.qty), 0)
    const onHand = Number(pstock.find(s => s.id === p.id)?.on_hand || 0)
    const planned = open.filter(b => b.product_id === p.id).reduce((s, b) => s + Number(b.batches) * Number(p.batch_yield || 0), 0)
    const toMake = Math.max(0, d - Math.max(onHand, 0) - planned)
    const suggest = toMake > 0 ? Math.ceil(toMake / (Number(p.batch_yield) || 1)) : 0
    return { p, demand: d, onHand, planned, toMake, suggest }
  }).filter(r => r.demand > 0 || r.planned > 0)
}

// raw materials needed for the given {product_id: batches}, compared with stock
export function materialNeeds(batchesByProduct, recipe, mstock) {
  const need = {}
  Object.entries(batchesByProduct).forEach(([pid, n]) => {
    if (!n) return
    recipe.filter(r => r.product_id === pid).forEach(r => { need[r.material_id] = (need[r.material_id] || 0) + Number(r.qty_per_batch) * n })
  })
  return Object.entries(need).map(([id, qty]) => {
    const m = mstock.find(x => x.id === id) || { id }
    return { m, qty, short: qty - Number(m.on_hand || 0) }
  }).sort((a, b) => b.short - a.short)
}
