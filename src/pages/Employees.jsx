import { useState } from 'react'
import CrudPage from '../components/CrudPage'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useT } from '../lib/i18n'
import { useToast, errText } from '../components/ui'
import { getPosition } from '../lib/clock'

const COLORS = ['#C2410C', '#0F766E', '#7C3AED', '#B45309', '#1D4ED8', '#BE185D', '#4D7C0F', '#475569']

// Employees who clock in (admins). Each can have a login (worker / staff / admin) and a PIN for the shared computer.
export default function Employees() {
  const t = useT()
  const { data: users } = useData(() => q(db.rpc('list_users')))
  const accounts = (users || []).filter(u => ['worker', 'staff', 'admin'].includes(u.role))
  const emailOf = id => accounts.find(u => u.user_id === id)?.email
  return (
    <CrudPage table="employees" title={t('nav_employees')} order="sort"
      searchKeys={['name', 'position', 'phone']}
      defaults={{ active: true }}
      columns={[
        { key: 'name', label: t('name'), render: r => <span className="emp-name"><i style={{ background: r.color || '#94A3B8' }} />{r.name}</span> },
        { key: 'position', label: t('position') },
        { key: 'user_id', label: t('loginAccount'), render: r => emailOf(r.user_id) || <span className="muted">{t('kioskOnly')}</span> },
        { key: 'phone', label: t('phone') },
      ]}
      fields={[
        { key: 'name', label: t('name'), required: true },
        { key: 'position', label: t('position') },
        { key: 'user_id', label: t('loginAccount'), type: 'select', hint: t('loginAccountHint'),
          options: accounts.map(u => [u.user_id, `${u.display_name || u.email} · ${u.email} (${t('role_' + u.role)})`]) },
        { key: 'phone', label: t('phone') },
        { key: 'color', label: t('color'), type: 'select', options: COLORS.map(c => [c, c]) },
        { key: 'sort', label: t('sortOrder'), type: 'number' },
        { key: 'active', label: t('active'), type: 'bool' },
      ]}
      extraFormContent={row => <PinSetter employeeId={row.id} />}>
      <ClockRules />
    </CrudPage>
  )
}

function PinSetter({ employeeId }) {
  const t = useT()
  const toast = useToast()
  const [pin, setPin] = useState('')
  async function save(value) {
    try { await q(db.rpc('set_employee_pin', { p_employee: employeeId, p_pin: value })); toast(value ? t('pinSaved') : t('pinRemoved')); setPin('') }
    catch (e) { toast(errText(e), 'error') }
  }
  return (
    <section className="subsection">
      <h3>{t('kioskPin')}</h3>
      <p className="muted small">{t('kioskPinHint')}</p>
      <div className="row-gap">
        <input inputMode="numeric" pattern="\d{4,6}" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="1234" aria-label={t('kioskPin')} style={{ maxWidth: 120 }} autoComplete="off" />
        <button type="button" className="btn btn-quiet" disabled={pin.length < 4} onClick={() => save(pin)}>{t('setPin')}</button>
        <button type="button" className="btn-link small" onClick={() => save('')}>{t('removePin')}</button>
      </div>
    </section>
  )
}

const RULE_KEYS = ['clock_mode', 'clock_ips', 'clock_lat', 'clock_lng', 'clock_radius_m', 'clock_max_accuracy_m']

// where clocking is allowed: company network (public IP) and/or GPS radius
function ClockRules() {
  const t = useT()
  const toast = useToast()
  const [v, setV] = useState(null)
  const [open, setOpen] = useState(false)
  const { data, reload } = useData(() => q(db.from('settings').select('key,value').in('key', RULE_KEYS)))
  const cur = v || Object.fromEntries((data || []).map(r => [r.key, r.value]))
  const set = (k, x) => setV({ ...cur, [k]: x })
  async function save() {
    try {
      await q(db.from('settings').upsert(RULE_KEYS.map(key => ({ key, value: String(cur[key] ?? '') }))))
      toast(t('saved')); setV(null); reload()
    } catch (e) { toast(errText(e), 'error') }
  }
  async function addMyIp() {
    try {
      const ip = await q(db.rpc('my_ip'))
      if (!ip) return toast(t('ipUnknown'), 'error')
      // IPv6 phones change their address: allow the whole /64 network
      const entry = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip
      const list = String(cur.clock_ips || '').split(',').map(x => x.trim()).filter(Boolean)
      if (!list.includes(entry)) set('clock_ips', [...list, entry].join(', '))
      toast(t('ipAdded', { ip: entry }))
    } catch (e) { toast(errText(e), 'error') }
  }
  async function useHere() {
    const p = await getPosition(15000)
    if (!p) return toast(t('clk_no_location'), 'error')
    setV({ ...cur, clock_lat: p.lat.toFixed(6), clock_lng: p.lng.toFixed(6) })
    toast(t('locationSet', { acc: Math.round(p.acc) }))
  }
  if (!data) return null
  const mode = cur.clock_mode || 'none'
  return (
    <section className="panel clock-rules">
      <button type="button" className="panel-head as-button" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <h2>{t('clockRules')}</h2><span className="muted small">{t('clkMode_' + mode)} {open ? '▴' : '▾'}</span>
      </button>
      {open && <div className="pad">
        <p className="muted small">{t('clockRulesHint')}</p>
        <div className="form-grid">
          <label className="field span-2"><span className="field-label">{t('clockRule')}</span>
            <select value={mode} onChange={e => set('clock_mode', e.target.value)}>
              {['none', 'wifi', 'location', 'either', 'both'].map(m => <option key={m} value={m}>{t('clkMode_' + m)}</option>)}
            </select></label>
          {mode !== 'none' && mode !== 'location' && <label className="field span-2"><span className="field-label">{t('companyNetwork')}</span>
            <input value={cur.clock_ips || ''} onChange={e => set('clock_ips', e.target.value)} placeholder="81.182.10.20, 2a01:36d:1::/64" />
            <span className="field-hint">{t('companyNetworkHint')} <button type="button" className="btn-link" onClick={addMyIp}>{t('addMyNetwork')}</button></span></label>}
          {mode !== 'none' && mode !== 'wifi' && <>
            <label className="field"><span className="field-label">{t('latitude')}</span>
              <input value={cur.clock_lat || ''} onChange={e => set('clock_lat', e.target.value)} inputMode="decimal" /></label>
            <label className="field"><span className="field-label">{t('longitude')}</span>
              <input value={cur.clock_lng || ''} onChange={e => set('clock_lng', e.target.value)} inputMode="decimal" /></label>
            <div className="span-2 small"><button type="button" className="btn btn-quiet btn-sm" onClick={useHere}>{t('useMyLocation')}</button>
              {cur.clock_lat && cur.clock_lng && <> · <a href={`https://www.google.com/maps/search/?api=1&query=${cur.clock_lat},${cur.clock_lng}`} target="_blank" rel="noreferrer">{t('showOnMap')}</a></>}</div>
            <label className="field"><span className="field-label">{t('radiusM')}</span>
              <input value={cur.clock_radius_m || ''} onChange={e => set('clock_radius_m', e.target.value)} inputMode="numeric" /></label>
            <label className="field"><span className="field-label">{t('maxAccuracyM')}</span>
              <input value={cur.clock_max_accuracy_m || ''} onChange={e => set('clock_max_accuracy_m', e.target.value)} inputMode="numeric" /></label>
          </>}
        </div>
        <div className="row-gap" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" disabled={!v} onClick={save}>{t('save')}</button>
        </div>
      </div>}
    </section>
  )
}
