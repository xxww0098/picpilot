import { useEffect } from 'react'
import { fetchQueueStats } from '../lib/queueApi'
import { useStore } from '../store'

const POLL_INTERVAL_MS = 5_000

/**
 * 单例轮询：仅当 enabled（有 running 任务）时拉取后端全局队列深度，写入 store 的 queueStats。
 * 供 QueueBanner 挂载一次即可——不要在每张 TaskCard 里调用，否则会变成 N 个并行轮询。
 * 仿 useNotificationUnread：interval + visibility/focus 即时刷新 + 静默失败 + 卸载清理。
 */
export function useQueueStats(enabled: boolean) {
  const setQueueStats = useStore((s) => s.setQueueStats)

  useEffect(() => {
    if (!enabled) {
      setQueueStats(null)
      return
    }
    let cancelled = false
    const refresh = async () => {
      try {
        const stats = await fetchQueueStats()
        if (!cancelled) setQueueStats(stats)
      } catch {
        // 静默失败，下一次轮询会重试；网络抖动不打扰用户
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    const onFocus = () => void refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, setQueueStats])
}
