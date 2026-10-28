import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase, db } from './supabase'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still loading
  const [profile, setProfile] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadProfile = useCallback(async () => {
    if (!session) { setProfile(null); return }
    const { data } = await db.from('profiles').select('*').eq('user_id', session.user.id).maybeSingle()
    setProfile(data || null)
  }, [session])

  useEffect(() => { if (session !== undefined) loadProfile() }, [session, loadProfile])

  const value = {
    session, profile, reloadProfile: loadProfile,
    isStaff: profile?.role === 'admin' || profile?.role === 'staff',
    isAdmin: profile?.role === 'admin',
    isRestaurant: profile?.role === 'restaurant',
    signOut: () => supabase.auth.signOut(),
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
