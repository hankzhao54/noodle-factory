import { useContext, useEffect, useState } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { configured, db } from './lib/supabase'
import { AuthProvider, useAuth } from './lib/auth'
import { LangContext, LANGS, useT } from './lib/i18n'
import { ToastProvider, Loading } from './components/ui'
import Login from './pages/Login'
import RequestAccess from './pages/RequestAccess'
import Dashboard from './pages/Dashboard'
import Materials from './pages/Materials'
import Suppliers from './pages/Suppliers'
import Products from './pages/Products'
import Purchasing from './pages/Purchasing'
import Inventory from './pages/Inventory'
import Production from './pages/Production'
import Customers from './pages/Customers'
import Orders from './pages/Orders'
import Deliveries from './pages/Deliveries'
import Users from './pages/Users'
import Portal from './portal/Portal'
import Trace from './pages/Trace'
import LabelSettings from './pages/LabelSettings'

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
        <AuthProvider><Gate /></AuthProvider>
      </ToastProvider>
    </LangContext.Provider>
  )
}

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

function StaffShell() {
  const t = useT()
  const { isAdmin, signOut, profile } = useAuth()
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => setOpen(false), [loc.pathname])

  const work = [
    ['/', 'nav_dashboard'], ['/orders', 'nav_orders'], ['/production', 'nav_production'],
    ['/deliveries', 'nav_deliveries'], ['/inventory', 'nav_inventory'], ['/purchasing', 'nav_purchasing'],
  ]
  const setup = [
    ['/products', 'nav_products'], ['/materials', 'nav_materials'], ['/suppliers', 'nav_suppliers'],
    ['/customers', 'nav_customers'], ['/label-settings', 'nav_labelSettings'], ...(isAdmin ? [['/users', 'nav_users']] : []),
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
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/production" element={<Production />} />
          <Route path="/deliveries" element={<Deliveries />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/purchasing" element={<Purchasing />} />
          <Route path="/products" element={<Products />} />
          <Route path="/materials" element={<Materials />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/trace/:lot" element={<Trace />} />
          <Route path="/label-settings" element={<LabelSettings />} />
          {isAdmin && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}
