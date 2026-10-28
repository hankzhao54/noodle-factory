import { useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, useToast, errText, NumInput } from './ui'

/*
  Generic list + edit form for simple master-data tables.
  fields: [{ key, label, type: text|number|bool|select|textarea|tags, options:[[v,label]], span, required, hint }]
  columns: [{ key, label, render?(row), num? }]
*/
export default function CrudPage({ table, title, columns, fields, defaults = {}, order = 'created_at',
  searchKeys = [], children, onRowClick, extraFormContent, afterSave, rowActions }) {
  const t = useT()
  const toast = useToast()
  const [editing, setEditing] = useState(null)
  const [term, setTerm] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const { data, loading, error, reload } = useData(
    () => q(db.from(table).select('*').order(order, { ascending: order !== 'created_at' })), [table])

  const rows = (data || [])
    .filter(r => showInactive || r.active !== false)
    .filter(r => !term || searchKeys.some(k => String(r[k] ?? '').toLowerCase().includes(term.toLowerCase())))

  return (
    <div className="page">
      <PageHead title={title}>
        {searchKeys.length > 0 && (
          <input className="search" type="search" placeholder={t('search')} value={term}
            onChange={e => setTerm(e.target.value)} aria-label={t('search')} />
        )}
        <label className="check-inline">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          {t('showInactive')}
        </label>
        <button className="btn btn-primary" onClick={() => setEditing({ ...defaults })}>{t('add')}</button>
      </PageHead>
      {children}
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : rows.length === 0 ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              {columns.map(c => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}
              <th className="act" aria-label={t('actions')} />
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={r.active === false ? 'row-off' : ''}>
                  {columns.map(c => (
                    <td key={c.key} className={c.num ? 'num' : ''}>
                      {c.render ? c.render(r) : (r[c.key] ?? '–')}
                    </td>
                  ))}
                  <td className="act">
                    {rowActions?.(r)}
                    <button className="btn btn-quiet" onClick={() => onRowClick ? onRowClick(r) : setEditing(r)}>{t('edit')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EditForm table={table} fields={fields} row={editing} title={title}
          extra={extraFormContent}
          onClose={() => setEditing(null)}
          onSaved={async saved => { setEditing(null); toast(t('saved')); await reload(); afterSave?.(saved) }}
          onDeleted={async () => { setEditing(null); await reload() }}
          onError={e => toast(errText(e), 'error')} />
      )}
    </div>
  )
}

function EditForm({ table, fields, row, title, onClose, onSaved, onDeleted, onError, extra }) {
  const t = useT()
  const [v, setV] = useState(() => {
    const o = { ...row }
    fields.forEach(f => { if (f.type === 'tags') o[f.key] = (row[f.key] || []).join(', ') })
    return o
  })
  const [busy, setBusy] = useState(false)
  const set = (k, val) => setV(s => ({ ...s, [k]: val }))

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    const payload = {}
    fields.forEach(f => {
      let val = v[f.key]
      if (f.type === 'tags') val = String(val || '').split(',').map(s => s.trim()).filter(Boolean)
      if (val === '' && f.type !== 'text' && f.type !== 'textarea') val = null
      if (f.type === 'select' && val === '') val = null
      payload[f.key] = val
    })
    try {
      const res = row.id
        ? await q(db.from(table).update(payload).eq('id', row.id).select().single())
        : await q(db.from(table).insert(payload).select().single())
      onSaved(res)
    } catch (err) { onError(err) } finally { setBusy(false) }
  }

  async function remove() {
    if (!confirm(t('confirmDelete'))) return
    try { await q(db.from(table).delete().eq('id', row.id)); onDeleted() }
    catch (err) { onError(err) }
  }

  return (
    <Modal title={(row.id ? t('edit') : t('add')) + ' · ' + title} onClose={onClose} wide={fields.length > 6}>
      <form className="form-grid" onSubmit={save} id="crud-form">
        {fields.map(f => (
          <Field key={f.key} label={f.label} hint={f.hint} span={f.span}>
            {f.type === 'bool' ? (
              <input type="checkbox" checked={!!v[f.key]} onChange={e => set(f.key, e.target.checked)} />
            ) : f.type === 'number' ? (
              <NumInput value={v[f.key]} onChange={x => set(f.key, x)} required={f.required} />
            ) : f.type === 'select' ? (
              <select value={v[f.key] ?? ''} onChange={e => set(f.key, e.target.value)} required={f.required}>
                {!f.required && <option value="">–</option>}
                {f.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea rows={3} value={v[f.key] ?? ''} onChange={e => set(f.key, e.target.value)} />
            ) : (
              <input type="text" value={v[f.key] ?? ''} onChange={e => set(f.key, e.target.value)}
                required={f.required} list={f.list} />
            )}
          </Field>
        ))}
      </form>
      {extra && row.id && extra(row)}
      <div className="modal-foot">
        {row.id && <button type="button" className="btn btn-danger-quiet" onClick={remove}>{t('delete')}</button>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
        <button type="submit" form="crud-form" className="btn btn-primary" disabled={busy}>{t('save')}</button>
      </div>
    </Modal>
  )
}
