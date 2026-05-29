import { useStore } from '../store'
import { useQueueStats } from '../hooks/useQueueStats'
import { computeQueueEtaMinutes, getRecentAvgTaskMs } from '../lib/queueApi'

/**
 * 队列深度提示：在画廊视图顶部挂载一次，作为全局排队状态的唯一轮询者。
 * 仅当确有人在排队（queued>0）时显示「当前 N 个请求排队中（预计 ~M 分钟）」，
 * 让用户知道"系统忙、不是卡住"，从而降低排队焦虑。空闲或只有自己在出图时不打扰。
 */
export default function QueueBanner() {
  const tasks = useStore((s) => s.tasks)
  const hasRunningTask = tasks.some((t) => t.status === 'running')
  useQueueStats(hasRunningTask)
  const queueStats = useStore((s) => s.queueStats)

  if (!hasRunningTask || !queueStats || queueStats.queued <= 0) return null

  const avgMs = getRecentAvgTaskMs(tasks)
  const etaMinutes = computeQueueEtaMinutes(queueStats.queued, queueStats.maxConcurrent, avgMs)

  return (
    <div className="mb-3 flex items-center justify-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))]">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400/70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>
        <span>
          当前 {queueStats.queued} 个请求排队中
          {etaMinutes != null ? `，预计 ~${etaMinutes} 分钟` : ''}
        </span>
      </div>
    </div>
  )
}
