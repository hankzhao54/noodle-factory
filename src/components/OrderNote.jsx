import { useState } from 'react'
import { db, q } from '../lib/supabase'
import { useT } from '../lib/i18n'
import { useToast, errText } from './ui'

// An order's note with edit / remove for staff (e.g. a note that no longer applies after a split)
export default function OrderNote({ order, onSaved, className = 'note-inline', readOnly }) {
  const t = useT()
  const toast = useToast()
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState(false)
  async function save(text) {
    setBusy(true)
    try {
      await q(db.from('orders').update({ notes: (text || '').trim() || null }).eq('id', order.id))
      toast(text?.trim() ? t('saved') : t('noteRemoved')); setEdit(null); onSaved?.()
    } catch (e) { toast(errText(e), 'error') }
    setBusy(false)
  }
  if (edit !== null) return (
    <span className="note-edit">
      <textarea rows={2} value={edit} autoFocus onChange={e => setEdit(e.target.value)} />
      <span className="note-edit-btns">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save(edit)}>{t('save')}</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEdit(null)}>{t('cancel')}</button>
      </span>
    </span>
  )
  if (!order.notes) return null
  return (
    <span className={className}>
      {order.notes}
      {!readOnly && <>
        {' '}<button type="button" className="btn-link small" title={t('edit')} onClick={() => setEdit(order.notes)}>✎</button>
        <button type="button" className="btn-link small danger" title={t('noteRemove')} disabled={busy} onClick={() => save('')}>✕</button>
      </>}
    </span>
  )
}
