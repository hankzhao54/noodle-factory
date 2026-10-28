import { useEffect, useState, useCallback } from 'react'

// tiny data hook: const { data, loading, error, reload } = useData(() => q(db.from('x').select()), [deps])
export function useData(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null })
  const run = useCallback(async () => {
    setState(s => ({ ...s, loading: true }))
    try { setState({ data: await fn(), loading: false, error: null }) }
    catch (error) { setState({ data: null, loading: false, error }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { run() }, [run])
  return { ...state, reload: run }
}
