import { useContext, useEffect, useState, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { configured, db, q } from './lib/supabase'
import { useData } from './lib/useData'
import { AuthProvider, useAuth } from './lib/auth'
import { LangContext, LANGS, useT } from './lib/i18n'
import { ToastProvider, Loading } from './components/ui'
import Login from './pages/Login'
import RequestAccess from './pages/RequestAccess'
// Pages are loaded on demand (React.lazy) so the heavy libraries they pull in
// (jspdf / exceljs / qrcode / html-to-image) are split into their own chunks
// and only downloaded when the matching page is first opened.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Materials = lazy(() => import('./pages/Materials'))
const Suppliers = lazy(() => import('./pages/Suppliers'))
const Products = lazy(() => import('./pages/Products'))
const Purchasing = lazy(() => import('./pages/Purchasing'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Production = lazy(() => import('./pages/Production'))
const Customers = lazy(() => import('./pages/Customers'))
const Orders = lazy(() => import('./pages/Orders'))
const Deliveries = lazy(() => import('./pages/Deliveries'))
const Users = lazy(() => import('./pages/Users'))
const Portal = lazy(() => import('./portal/Portal'))
const Trace = lazy(() => import('./pages/Trace'))
const LabelSettings = lazy(() => import('./pages/LabelSettings'))
const EmailSettings = lazy(() => import('./pages/EmailSettings'))
const RuleSettings = lazy(() => import('./pages/RuleSettings'))
const Reports = lazy(() => import('./pages/Reports'))
const PriceTiers = lazy(() => import('./pages/PriceTiers'))
const LegalPage = lazy(() => import('./legal/LegalPage'))
const Activity = lazy(() => import('./pages/Activity'))
const MonthlyReport = lazy(() => import('./pages/MonthlyReport'))
const Costs = lazy(() => import('./pages/Costs'))
const Labels = lazy(() => import('./pages/Labels'))


export default function App() {
  const [lang, setLangState] = useState(() => localStorage.getItem('nf-lang') || 'hu')
  const setLang = l => { setLangState(l); localStorage.setItem('nf-lang', l); document.documentElement.lang = l }
  useEffect(() => { document.documentElement.lang = lang }, [lang])

  if (!configured) return (
    <div className="center-screen"><div className="card-plain">
      <h1>Setup needed</h1>
      <p>Create a <code>.env</code> file with <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>), then restart.</p>
    </div></div>
  )
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <ToastProvider>
        <Suspense fallback={<div className="center-screen"><Loading /></div>}>
          <Routes>
            {/* legal pages are public: no sign-in needed */}
            <Route path="/legal/:doc" element={<LegalPage />} />
            <Route path="*" element={<AuthProvider><Gate /></AuthProvider>} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </LangContext.Provider>
  )
}

const Icon = ({ d }) => <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>

function Gate() {
  const { session, profile } = useAuth()
  const { setLang } = useLang()
  // adopt the language saved on the profile once
  useEffect(() => { if (profile?.lang && !localStorage.getItem('nf-lang')) setLang(profile.lang) }, [profile]) // eslint-disable-line
  if (session === undefined || (session && profile === undefined)) return <div className="center-screen"><Loading /></div>
  if (!session) return <Login />
  if (!profile || profile.role === 'pending') return <RequestAccess profile={profile} />
  if (profile.role === 'customer' || profile.role === 'restaurant') return <Portal />
  return <StaffShell />
}

export const useLang = () => useContext(LangContext)

export function LangSwitch({ dark }) {
  const { lang, setLang } = useLang()
  return (
    <div className={`lang-switch ${dark ? 'on-dark' : ''}`} role="group" aria-label="Language">
      {LANGS.map(l => (
        <button key={l.code} aria-pressed={lang === l.code} className={lang === l.code ? 'on' : ''}
          onClick={() => { setLang(l.code); db.rpc('set_my_lang', { p_lang: l.code }) }}>{l.label}</button>
      ))}
    </div>
  )
}

import IdleLogout from './components/IdleLogout'

function StaffShell() {
  const t = useT()
  const { isAdmin, signOut, profile } = useAuth()
  const [open, setOpen] = useState(false)
  // the Costs page is only for the people in noodle.cost_viewers (not every admin)
  const costViewer = useData(() => q(db.rpc('is_cost_viewer')).catch(() => false), [profile?.user_id]).data === true
  const loc = useLocation()
  useEffect(() => setOpen(false), [loc.pathname])

  const work = [
    ['/', 'nav_dashboard'], ['/labels', 'nav_labels'], ['/orders', 'nav_orders'], ['/production', 'nav_production'],
    ['/deliveries', 'nav_deliveries'], ['/inventory', 'nav_inventory'], ['/purchasing', 'nav_purchasing'], ['/reports', 'nav_reports'],
  ]
  const setup = [
    ['/products', 'nav_products'], ['/materials', 'nav_materials'], ['/suppliers', 'nav_suppliers'],
    ['/customers', 'nav_customers'], ['/label-settings', 'nav_labelSettings'], ['/email-settings', 'nav_emailSettings'], ...(costViewer ? [['/costs', 'nav_costs']] : []), ...(isAdmin ? [['/price-tiers', 'nav_priceTiers'], ['/rules', 'nav_ruleSettings'], ['/monthly-report', 'nav_monthReport'], ['/users', 'nav_users'], ['/activity', 'nav_activity']] : []),
  ]
  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="side">
        <div className="brand">
          <img src="/icon.svg" alt="" width="30" height="30" />
          <span>{t('appName')}</span>
        </div>
        <nav aria-label="Main">
          <p className="nav-group">{t('nav_group_work')}</p>
          {work.map(([to, k]) => <NavLink key={to} to={to} end={to === '/'}>{t(k)}</NavLink>)}
          <p className="nav-group">{t('nav_group_setup')}</p>
          {setup.map(([to, k]) => <NavLink key={to} to={to}>{t(k)}</NavLink>)}
        </nav>
        <div className="side-foot">
          <LangSwitch dark />
          <div className="who">{profile?.display_name || ''}</div>
          <button className="btn-link on-dark" onClick={signOut}>{t('signOut')}</button>
        </div>
      </aside>
      <div className="topbar">
        <button className="btn-icon" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>☰</button>
        <span className="topbar-title">{t('appName')}</span>
      </div>
      <div className="scrim" onClick={() => setOpen(false)} />
      <IdleLogout />
      {/* phone: app-style tab bar; "More" opens the full menu */}
      <nav className="tabbar" aria-label="Tabs">
        <NavLink to="/" end><Icon d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /><span>{t('tab_today')}</span></NavLink>
        <NavLink to="/orders"><Icon d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /><span>{t('tab_orders')}</span></NavLink>
        <NavLink to="/labels" className="tab-main"><Icon d="M3 12V4h8l10 10-8 8zM7.5 8.5h.01" /><span>{t('tab_labels')}</span></NavLink>
        <NavLink to="/deliveries"><Icon d="M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-.1M17 19a2 2 0 1 0 0-.1" /><span>{t('tab_deliveries')}</span></NavLink>
        <button type="button" className={open ? 'active' : ''} onClick={() => setOpen(o => !o)}><Icon d="M4 7h16M4 12h16M4 17h16" /><span>{t('tab_more')}</span></button>
      </nav>
      <main className="main">
        <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/production" element={<Production />} />
          <Route path="/labels" element={<Labels />} />
          <Route path="/pack-labels" element={<Navigate to="/labels" replace />} />
          <Route path="/driver" element={<Navigate to="/deliveries?driver=1" replace />} />
          <Route path="/deliveries" element={<Deliveries />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/purchasing" element={<Purchasing />} />
          <Route path="/products" element={<Products />} />
          <Route path="/materials" element={<Materials />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/trace/:lot" element={<Trace />} />
          <Route path="/label-settings" element={<LabelSettings />} />
          <Route path="/email-settings" element={<EmailSettings />} />
          {isAdmin && <Route path="/rules" element={<RuleSettings />} />}
          <Route path="/reports" element={<Reports />} />
          {isAdmin && <Route path="/price-tiers" element={<PriceTiers />} />}
          {isAdmin && <Route path="/users" element={<Users />} />}
          {isAdmin && <Route path="/activity" element={<Activity />} />}
          {isAdmin && <Route path="/monthly-report" element={<MonthlyReport />} />}
          <Route path="/costs" element={<Costs />} />{/* the page itself checks cost_viewers */}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  )
}

