import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
export const configured = Boolean(url && key)

// storageKey keeps this login separate from order-app / recipes on the same browser
export const supabase = configured
  ? createClient(url, key, { auth: { storageKey: 'noodle-factory-auth' } })
  : null

// all app tables live in the `noodle` schema
export const db = configured ? supabase.schema('noodle') : null

export async function q(promise) {
  const { data, error } = await promise
  if (error) throw error
  return data
}

export const todayISO = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
