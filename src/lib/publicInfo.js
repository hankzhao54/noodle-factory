import { useEffect, useState } from 'react'
import { db } from './supabase'

// Company details + terms version (public, readable without signing in). Cached for the session.
let cache = null
export function usePublicInfo() {
  const [info, setInfo] = useState(cache)
  useEffect(() => {
    if (cache) return
    db.rpc('public_info').then(({ data, error }) => {
      if (data) { cache = data; setInfo(data) } else if (error) setInfo({})   // still render; missing values show as "…"
    })
  }, [])
  return info
}
export const refreshPublicInfo = () => { cache = null }
