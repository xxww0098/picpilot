import { useCallback, useEffect, useState } from 'react'
import { fetchUnreadCount } from '../lib/server/notificationApi'

const POLL_INTERVAL_MS = 60_000

export function useNotificationUnread(enabled: boolean) {
  const [unread, setUnread] = useState(0)

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const { unread } = await fetchUnreadCount()
      setUnread(unread)
    } catch {
      // 静默失败，下一次轮询会重试；网络失败不打扰用户
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setUnread(0)
      return
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    const onFocus = () => void refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, refresh])

  return { unread, setUnread, refresh }
}
