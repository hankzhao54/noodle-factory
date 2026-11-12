import { useEffect, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT, fmtDate } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, useToast, errText } from '../components/ui'
import { parseDays, parseDates, nextDates, dayName } from '../lib/orderRules'
import { refreshPublicInfo } from '../lib/publicInfo'
import { LEGAL } from '../legal/LegalPage'

const COMPANY = ['company_name', 'company_address', 'company_reg_no', 'company_court', 'company_tax_no', 'company_email', 'company_phone', 'company_authority', 'terms_version']
const KEYS = ['order_cutoff_time', 'order_lead_days', 'order_weekdays', 'order_closed_dates', 'order_close_hu_holidays', 'order_close_bridge_days', 'order_bridge_days', 'urgent_orders', 'lot_expiry_warn_days', ...COMPANY]

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
    const clean = { ...v, order_closed_dates: parseDates(v.order_closed_dates).join(', '), order_bridge_days: parseDates(v.order_bridge_days).join(', ') }
    try {
      const now = new Date().toISOString()
      await q(db.from('settings').upsert(KEYS.map(k => ({ key: k, value: String(clean[k] ?? ''), updated_at: now }))))
      refreshPublicInfo(); toast(t('saved')); reload()
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
          <div className="field span-2"><span className="field-label">{t('rsHolidays')}</span>
            <label className="check-inline"><input type="checkbox" disabled={off} checked={(v.order_close_hu_holidays ?? 'true') === 'true'}
              onChange={e => set('order_close_hu_holidays', String(e.target.checked))} />{t('rsHuHolidays')}</label>
            <span className="field-hint">{t('rsHuHolidaysHint')}</span>
            <label className="check-inline"><input type="checkbox" disabled={off} checked={v.order_close_bridge_days === 'true'}
              onChange={e => set('order_close_bridge_days', String(e.target.checked))} />{t('rsBridge')}</label>
            {v.order_close_bridge_days === 'true' && <>
              <input type="text" placeholder="2026-01-02, 2026-08-21" value={v.order_bridge_days || ''} disabled={off} aria-label={t('rsBridge')}
                onChange={e => set('order_bridge_days', e.target.value)} />
              <span className="field-hint">{t('rsBridgeHint')}</span></>}
          </div>
          <label className="field"><span className="field-label">🚨 {t('rsUrgent')}</span>
            <select value={v.urgent_orders || 'all'} disabled={off} onChange={e => set('urgent_orders', e.target.value)}>
              <option value="all">{t('rsUrgentAll')}</option>
              <option value="internal">{t('rsUrgentInternal')}</option>
              <option value="off">{t('rsUrgentOff')}</option>
            </select>
            <span className="field-hint">{t('rsUrgentHint')}</span></label>
          <label className="field span-2"><span className="field-label">{t('rsClosed')}</span>
            <input type="text" placeholder="2026-12-24, 2026-12-25" value={v.order_closed_dates || ''} disabled={off} onChange={e => set('order_closed_dates', e.target.value)} />
            <span className="field-hint">{t('rsClosedHint')}</span></label>
          {data.rules?.closed_list?.length > 0 && <details className="span-2 closed-list"><summary className="small">{t('rsClosedUpcoming', { n: data.rules.closed_list.length })}</summary>
            <ul className="small">{data.rules.closed_list.map(x => <li key={x.date}>{fmtDate(x.date, t.lang)} · {x.name || t('rsManual')}</li>)}</ul></details>}
          <p className="muted small span-2">{t('rsPreview')}: {preview.map(d => fmtDate(d, t.lang)).join(' · ') || '–'}</p>
        </div>
        <div className="panel-head"><h2>{t('rsLots')}</h2></div>
        <div className="form-grid pad">
          <label className="field"><span className="field-label">{t('rsWarnDays')}</span>
            <input type="number" min="0" max="365" value={v.lot_expiry_warn_days ?? ''} disabled={off} onChange={e => set('lot_expiry_warn_days', e.target.value)} /></label>
        </div>
        <div className="panel-head"><h2>{t('rsCompany')}</h2>
          <span className="row-gap">{LEGAL.map(([k, label]) => <a key={k} className="small" href={`/legal/${k}`} target="_blank" rel="noopener">{t(label)}</a>)}</span></div>
        <p className="muted small pad-x">{t('rsCompanyHint')}</p>
        <div className="form-grid pad">
          {COMPANY.map(k => (
            <label key={k} className={`field ${k === 'company_address' ? 'span-2' : ''}`}><span className="field-label">{t('co_' + k)}</span>
              <input value={v[k] || ''} disabled={off} onChange={e => set(k, e.target.value)} />
              {k === 'terms_version' && <span className="field-hint">{t('termsVersionHint')}</span>}
              {(k === 'company_reg_no' || k === 'company_tax_no') && !v[k] && <span className="field-hint warn">{t('missing')}</span>}
            </label>
          ))}
        </div>
        {!off && <div className="modal-foot pad"><span className="grow" />
          <button className="btn btn-primary" disabled={!dirty}>{t('save')}</button></div>}
      </form>
    </div>
  )
}
