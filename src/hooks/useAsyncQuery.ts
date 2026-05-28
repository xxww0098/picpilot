import { useCallback, useEffect, useState } from 'react'
import { getUserFacingErrorMessage } from '../lib/userFacingText'

export function useAsyncQuery<T>(queryFn: () => Promise<T>, deps: readonly unknown[], enabled = true) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const result = await queryFn()
      setData(result)
      setError('')
    } catch (e) {
      setError(getUserFacingErrorMessage(e, '加载失败'))
    } finally {
      setLoading(false)
    }
  // queryFn 由 deps 控制何时重新请求
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, loading, error, reload, setData }
}
