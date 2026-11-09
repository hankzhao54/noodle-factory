import { useEffect, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT } from '../lib/i18n'
import { Modal, Field, Empty, Loading, ErrorBox, PageHead, useToast, errText, NumInput } from './ui'
import ImageThumb from './ImageThumb'
import { imageUrl, uploadImage, removeImage } from '../lib/images'
import { dayName } from '../lib/orderRules'

/*
  Generic list + edit form for simple master-data tables.
  fields: [{ key, label, type: text|number|bool|select|textarea|tags, options:[[v,label]], span, required, hint }]
  columns: [{ key, label, render?(row), num? }]
  imageFolder: when set ('materials' / 'products'), rows get a photo (image_path column)
*/
export default function CrudPage({ table, title, columns, fields, defaults = {}, order = 'created_at',
  searchKeys = [], children, onRowClick, extraFormContent, afterSave, rowActions, imageFolder, select = '*' }) {
  const t = useT()
  const toast = useToast()
  const [editing, setEditing] = useState(null)
  const [term, setTerm] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [bigImage, setBigImage] = useState(null)
  const { data, loading, error, reload } = useData(
    () => q(db.from(table).select(select).order(order, { ascending: order !== 'created_at' })), [table])

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
              {imageFolder && <th className="thumb-col" aria-label={t('photo')} />}
              {columns.map(c => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}
              <th className="act" aria-label={t('actions')} />
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={r.active === false ? 'row-off' : ''}>
                  {imageFolder && (
                    <td className="thumb-col">
                      <ImageThumb path={r.image_path} alt={t('photo')}
                        onClick={r.image_path ? () => setBigImage(r.image_path) : undefined} />
                    </td>
                  )}
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
      {bigImage && (
        <Modal title={t('photo')} onClose={() => setBigImage(null)}>
          <img className="photo-big" src={imageUrl(bigImage)} alt={t('photo')} />
        </Modal>
      )}
      {editing && (
        <EditForm table={table} imageFolder={imageFolder} fields={fields} row={editing} title={title}
          extra={extraFormContent}
          onClose={() => setEditing(null)}
          onSaved={async saved => {
            // a new row with extra sections (e.g. customer prices): stay open so they can be filled right away
            setEditing(!editing.id && extraFormContent ? saved : null)
            toast(t('saved')); await reload(); afterSave?.(saved) }}
          onDeleted={async msg => { setEditing(null); toast(msg || t('deleted')); await reload() }}
          onError={e => toast(errText(e), 'error')} />
      )}
    </div>
  )
}

function EditForm({ table, fields, row, title, onClose, onSaved, onDeleted, onError, extra, imageFolder }) {
  const t = useT()
  const [v, setV] = useState(() => {
    const o = { ...row }
    fields.forEach(f => { if (f.type === 'tags') o[f.key] = (row[f.key] || []).join(', ') })
    fields.forEach(f => { if (f.display && o[f.key]) o[f.key] = f.display(o[f.key]) })
    return o
  })
  const [busy, setBusy] = useState(false)
  // photo: { file: picked File not yet uploaded, removed: user cleared the current one }
  const [photo, setPhoto] = useState({ file: null, removed: false })
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
      if (f.type === 'weekdays') val = Array.isArray(val) && val.length ? [...val].sort() : null
      payload[f.key] = val
    })
    try {
      let res = row.id
        ? await q(db.from(table).update(payload).eq('id', row.id).select().single())
        : await q(db.from(table).insert(payload).select().single())
      if (imageFolder && (photo.file || photo.removed)) {
        try {
          const path = photo.file ? await uploadImage(imageFolder, res.id, photo.file) : null
          res = await q(db.from(table).update({ image_path: path }).eq('id', res.id).select().single())
          if (row.image_path && row.image_path !== path) removeImage(row.image_path)
        } catch (err) { onError(err); onSaved(res); return }
      }
      onSaved(res)
    } catch (err) { onError(err) } finally { setBusy(false) }
  }

  // two-step delete inside the dialog (browser confirm() popups are blocked in some apps).
  // If the row is still referenced (e.g. a customer with orders), offer to deactivate instead.
  const [del, setDel] = useState(null)   // null | 'ask' | 'used'
  const canDeactivate = fields.some(f => f.key === 'active')
  async function remove() {
    try { await q(db.from(table).delete().eq('id', row.id)); onDeleted() }
    catch (err) {
      if (/foreign key/i.test(err.message || '')) setDel('used')
      else { setDel(null); onError(err) }
    }
  }
  async function deactivate() {
    try { await q(db.from(table).update({ active: false }).eq('id', row.id)); onDeleted(t('deactivated')) }
    catch (err) { onError(err) }
  }

  return (
    <Modal title={(row.id ? t('edit') : t('add')) + ' · ' + title} onClose={onClose} wide={fields.length > 6}>
      <form className="form-grid" onSubmit={save} id="crud-form">
        {imageFolder && <PhotoField current={photo.removed ? null : row.image_path} photo={photo} setPhoto={setPhoto} />}
        {fields.map(f => f.type === 'weekdays' ? (
          <div key={f.key} className={`field ${f.span ? 'span-' + f.span : ''}`} role="group" aria-label={f.label}>
            <span className="field-label">{f.label}</span>
            <span className="day-picker">{[1, 2, 3, 4, 5, 6, 7].map(d => {
              const cur = Array.isArray(v[f.key]) ? v[f.key].map(Number) : []
              return (
                <label key={d} className={cur.includes(d) ? 'day on' : 'day'}>
                  <input type="checkbox" checked={cur.includes(d)}
                    onChange={() => set(f.key, cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d])} />
                  {dayName(t.lang, d)}
                </label>)
            })}</span>
            {f.hint && <span className="field-hint">{f.hint}</span>}
          </div>
        ) : (
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
      {extra && !row.id && <p className="muted small">{t('moreAfterSave')}</p>}
      {del === 'ask' && <p className="note-box">{t('confirmDelete')}</p>}
      {del === 'used' && <p className="note-box">{canDeactivate ? t('inUseDeactivate') : t('inUseNoDelete')}</p>}
      <div className="modal-foot">
        {row.id && (del === 'used'
          ? (canDeactivate && row.active !== false && <button type="button" className="btn btn-danger" onClick={deactivate}>{t('deactivate')}</button>)
          : del === 'ask'
            ? <><button type="button" className="btn btn-danger" onClick={remove}>{t('confirmDeleteBtn')}</button>
                <button type="button" className="btn btn-quiet" onClick={() => setDel(null)}>{t('cancel')}</button></>
            : <button type="button" className="btn btn-danger-quiet" onClick={() => setDel('ask')}>{t('delete')}</button>)}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
        <button type="submit" form="crud-form" className="btn btn-primary" disabled={busy}>{t('save')}</button>
      </div>
    </Modal>
  )
}

function PhotoField({ current, photo, setPhoto }) {
  const t = useT()
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    if (!photo.file) { setPreview(null); return }
    const u = URL.createObjectURL(photo.file); setPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [photo.file])
  const shown = preview || imageUrl(current)
  return (
    <div className="field span-2 photo-field">
      <span className="field-label">{t('photo')}</span>
      <div className="photo-row">
        <ImageThumb src={shown} size={96} alt={t('photo')} />
        <div className="photo-actions">
          <label className="btn">
            {shown ? t('changePhoto') : t('addPhoto')}
            <input type="file" accept="image/*" hidden onChange={e => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (f) setPhoto({ file: f, removed: false })
            }} />
          </label>
          {shown && <button type="button" className="btn btn-danger-quiet"
            onClick={() => setPhoto({ file: null, removed: true })}>{t('removePhoto')}</button>}
          <span className="field-hint">{t('photoHint')}</span>
        </div>
      </div>
    </div>
  )
}
