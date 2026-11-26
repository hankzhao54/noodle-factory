import { useEffect, useState, useCallback } from 'react'

// tiny data hook: const { data, loading, error, reload } = useData(() => q(db.from('x').select()), [deps])
export function useData(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null })
  const run = useCallback(async (live = () => true) => {
    setState(s => ({ ...s, loading: true }))
    try { const data = await fn(); if (live()) setState({ data, loading: false, error: null }) }
    catch (error) { if (live()) setState({ data: null, loading: false, error }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    // ignore stale results: a request started for old deps must not overwrite
    // newer data, and nothing should setState after unmount
    let ignore = false
    run(() => !ignore)
    return () => { ignore = true }
  }, [run])
  return { ...state, reload: run }
}
