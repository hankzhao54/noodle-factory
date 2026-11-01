import { useEffect, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, useToast, errText } from '../components/ui'
import { parseDays, parseDates, nextDates, dayName } from '../lib/orderRules'

const KEYS = ['order_cutoff_time', 'order_lead_days', 'order_weekdays', 'order_closed_dates', 'lot_expiry_warn_days']

// Ordering rules (cutoff, lead time, delivery weekdays, closed dates) and the lot expiry warning
export default function RuleSettings() {
  const t = useT()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const { data, error, reload } = useData(async () => {
    const [cfg, rules] = await Promise.all([
      q(db.from('settings').select('key,value').in('key', KEYS)),
      q(db.rpc('order_rules')),
    ])
    return { cfg: Object.fromEntries(cfg.map(r => [r.key, r.value])), rules }
  })
  const [v, setV] = useState(null)
  useEffect(() => { if (data) setV(data.cfg) }, [data])
  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data || !v) return <div className="page"><Loading /></div>

  const set = (k, val) => setV(s => ({ ...s, [k]: val }))
  const days = parseDays(v.order_weekdays)
  const toggleDay = d => set('order_weekdays', [1, 2, 3, 4, 5, 6, 7].filter(x => x === d ? !days.includes(d) : days.includes(x)).join(','))
  const dirty = KEYS.some(k => (v[k] ?? '') !== (data.cfg[k] ?? ''))
  const off = !isAdmin
  async function save(e) {
    e.preventDefault()
    const clean = { ...v, order_closed_dates: parseDates(v.order_closed_dates).join(', ') }
    try {
      const now = new Date().toISOString()
      await q(db.from('settings').upsert(KEYS.map(k => ({ key: k, value: String(clean[k] ?? ''), updated_at: now }))))
      toast(t('saved')); reload()
    } catch (err) { toast(errText(err), 'error') }
  }
  const preview = nextDates({ ...data.rules, my_weekdays: null }, 6)

  return (
    <div className="page">
      <PageHead title={t('nav_ruleSettings')} />
      <p className="muted lead">{t('rsIntro')}</p>
      <form className="panel" onSubmit={save}>
        <div className="panel-head"><h2>{t('rsOrdering')}</h2>{off && <span className="muted small">{t('lsAdminOnly')}</span>}</div>
        <div className="form-grid pad">
          <label className="field"><span className="field-label">{t('rsCutoff')}</span>
            <input type="time" value={v.order_cutoff_time || ''} disabled={off} onChange={e => set('order_cutoff_time', e.target.value)} />
            <span className="field-hint">{t('rsCutoffHint')}</span></label>
          <label className="field"><span className="field-label">{t('rsLead')}</span>
            <input type="number" min="0" max="14" value={v.order_lead_days ?? ''} disabled={off} onChange={e => set('order_lead_days', e.target.value)} />
            <span className="field-hint">{t('rsLeadHint')}</span></label>
          <div className="field span-2"><span className="field-label">{t('rsWeekdays')}</span>
            <div className="day-picker">{[1, 2, 3, 4, 5, 6, 7].map(d => (
              <label key={d} className={days.includes(d) ? 'day on' : 'day'}>
                <input type="checkbox" checked={days.includes(d)} disabled={off} onChange={() => toggleDay(d)} />{dayName(t.lang, d)}
              </label>))}</div>
            <span className="field-hint">{t('rsWeekdaysHint')}</span></div>
          <label className="field span-2"><span className="field-label">{t('rsClosed')}</span>
            <input type="text" placeholder="2026-12-24, 2026-12-25" value={v.order_closed_dates || ''} disabled={off} onChange={e => set('order_closed_dates', e.target.value)} />
            <span className="field-hint">{t('rsClosedHint')}</span></label>
          <p className="muted small span-2">{t('rsPreview')}: {preview.map(d => fmtDate(d, t.lang)).join(' · ') || '–'}</p>
        </div>
        <div className="panel-head"><h2>{t('rsLots')}</h2></div>
        <div className="form-grid pad">
          <label className="field"><span className="field-label">{t('rsWarnDays')}</span>
            <input type="number" min="0" max="365" value={v.lot_expiry_warn_days ?? ''} disabled={off} onChange={e => set('lot_expiry_warn_days', e.target.value)} /></label>
        </div>
        {!off && <div className="modal-foot pad"><span className="grow" />
          <button className="btn btn-primary" disabled={!dirty}>{t('save')}</button></div>}
      </form>
    </div>
  )
}
