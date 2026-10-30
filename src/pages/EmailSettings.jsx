import { useEffect, useState } from 'react'
import { db, q } from '../lib/supabase'
import { useData } from '../lib/useData'
import { useAuth } from '../lib/auth'
import { useT } from '../lib/i18n'
import { Loading, ErrorBox, PageHead, Empty, useToast, errText } from '../components/ui'

const KEYS = ['email_mode', 'email_test_to', 'email_factory_to', 'email_factory_lang', 'email_from', 'email_reply_to', 'email_block']

// Order emails: on/off/test mode, alert address, sender, and the log of what was sent.
export default function EmailSettings() {
  const t = useT()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const { data, error, reload } = useData(async () => {
    const [cfg, log] = await Promise.all([
      q(db.from('settings').select('key,value').in('key', KEYS)),
      q(db.from('email_log').select('id, order_id, kind, recipient, status, detail, created_at, orders(no)').order('created_at', { ascending: false }).limit(50)),
    ])
    return { cfg: Object.fromEntries(cfg.map(r => [r.key, r.value])), log }
  })
  const [v, setV] = useState(null)
  useEffect(() => { if (data) setV(data.cfg) }, [data])

  if (error) return <div className="page"><ErrorBox error={error} /></div>
  if (!data || !v) return <div className="page"><Loading /></div>

  const set = (k, val) => setV(s => ({ ...s, [k]: val }))
  const dirty = KEYS.some(k => (v[k] ?? '') !== (data.cfg[k] ?? ''))
  async function save(e) {
    e.preventDefault()
    try {
      const now = new Date().toISOString()
      await q(db.from('settings').upsert(KEYS.map(k => ({ key: k, value: v[k] ?? '', updated_at: now }))))
      toast(t('saved')); reload()
    } catch (err) { toast(errText(err), 'error') }
  }
  const off = !isAdmin

  return (
    <div className="page">
      <PageHead title={t('nav_emailSettings')} />
      <p className="muted lead">{t('emIntro')}</p>

      <form className="panel" onSubmit={save}>
        <div className="panel-head"><h2>{t('emSettings')}</h2>{off && <span className="muted small">{t('lsAdminOnly')}</span>}</div>
        <div className="form-grid pad">
          <label className="field span-2"><span className="field-label">{t('emMode')}</span>
            <select value={v.email_mode || 'off'} disabled={off} onChange={e => set('email_mode', e.target.value)}>
              <option value="off">{t('emModeOff')}</option>
              <option value="test">{t('emModeTest')}</option>
              <option value="live">{t('emModeLive')}</option>
            </select>
            <span className="field-hint">{t('emModeHint')}</span></label>
          <label className="field"><span className="field-label">{t('emTestTo')}</span>
            <input type="text" value={v.email_test_to || ''} disabled={off} onChange={e => set('email_test_to', e.target.value)} /></label>
          <label className="field"><span className="field-label">{t('emFactoryTo')}</span>
            <input type="text" value={v.email_factory_to || ''} disabled={off} onChange={e => set('email_factory_to', e.target.value)} />
            <span className="field-hint">{t('emFactoryHint')}</span></label>
          <label className="field"><span className="field-label">{t('emFactoryLang')}</span>
            <select value={v.email_factory_lang || 'hu'} disabled={off} onChange={e => set('email_factory_lang', e.target.value)}>
              <option value="hu">Magyar</option><option value="en">English</option><option value="zh">中文</option>
            </select></label>
          <label className="field"><span className="field-label">{t('emFrom')}</span>
            <input type="text" value={v.email_from || ''} disabled={off} onChange={e => set('email_from', e.target.value)} /></label>
          <label className="field"><span className="field-label">{t('emReplyTo')}</span>
            <input type="text" value={v.email_reply_to || ''} disabled={off} onChange={e => set('email_reply_to', e.target.value)} /></label>
          <label className="field span-2"><span className="field-label">{t('emBlock')}</span>
            <input type="text" value={v.email_block || ''} disabled={off} onChange={e => set('email_block', e.target.value)} />
            <span className="field-hint">{t('emBlockHint')}</span></label>
          <p className="muted small span-2">{t('emCustomerHint')}</p>
        </div>
        {!off && <div className="modal-foot pad"><span className="grow" />
          <button className="btn btn-primary" disabled={!dirty}>{t('save')}</button></div>}
      </form>

      <section className="panel">
        <div className="panel-head"><h2>{t('emLog')}</h2><button type="button" className="btn btn-quiet" onClick={reload}>{t('refresh')}</button></div>
        {data.log.length === 0 ? <Empty>{t('emLogEmpty')}</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('emTime')}</th><th>#</th><th>{t('emKind')}</th><th>{t('emRecipient')}</th><th>{t('status')}</th></tr></thead>
            <tbody>{data.log.map(r => (
              <tr key={r.id}>
                <td className="muted small">{new Date(r.created_at).toLocaleString(t.lang === 'hu' ? 'hu-HU' : t.lang === 'zh' ? 'zh-CN' : 'en-GB')}</td>
                <td>{r.orders?.no ? `#${r.orders.no}` : '–'}</td>
                <td>{t('emKind_' + r.kind)}</td>
                <td className="small">{r.recipient}</td>
                <td title={r.status === 'failed' ? r.detail : ''}>
                  <span className={`status ${r.status === 'sent' ? 'st-delivered' : 'st-failed'}`}>{t('emSt_' + r.status)}</span>
                  {r.status === 'failed' && <div className="muted small">{String(r.detail || '').slice(0, 120)}</div>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  )
}
