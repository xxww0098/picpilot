import { authFetch } from './auth'
import type { TaskRecord } from '../types'

export interface QueueStats {
  /** 当前在途（正在出图）的请求数 */
  inflight: number
  /** 当前排队等待的请求数 */
  queued: number
  /** 全局并发上限 */
  maxConcurrent: number
  /** 排队长度上限 */
  maxQueue: number
  /** 当前登录用户正在排队的请求数 */
  myQueued: number
  /** 当前登录用户第一个等待请求在 FIFO 队列中的 1-based 位置；未排队为 null */
  myNextPosition: number | null
}

export async function fetchQueueStats(): Promise<QueueStats> {
  const res = await authFetch('/api/queue/stats')
  if (!res.ok) throw new Error('加载队列状态失败')
  return (await res.json()) as QueueStats
}

// ETA 估计需要的最少历史样本数；不足则不展示分钟数，只显示队列深度（保持诚实，不臆造倒计时）。
const MIN_SAMPLES_FOR_ETA = 2

/**
 * 取最近若干个已完成任务的平均耗时（ms），作为排队 ETA 的基数。
 * tasks 约定为新→旧排序（store 中新任务 unshift 在最前）。样本不足返回 null。
 */
export function getRecentAvgTaskMs(
  tasks: ReadonlyArray<Pick<TaskRecord, 'status' | 'elapsed'>>,
  sampleSize = 8,
): number | null {
  const samples: number[] = []
  for (const t of tasks) {
    if (t.status === 'done' && typeof t.elapsed === 'number' && t.elapsed > 0) {
      samples.push(t.elapsed)
      if (samples.length >= sampleSize) break
    }
  }
  if (samples.length < MIN_SAMPLES_FOR_ETA) return null
  return samples.reduce((sum, v) => sum + v, 0) / samples.length
}

/**
 * 诚实的排队等待估计：queued 个等待请求，按 maxConcurrent 并发吞吐、单请求均耗 avgMs。
 * 返回向上取整的分钟数（至少 1）；无法估计（无排队 / 无样本）时返回 null。
 */
export function computeQueueEtaMinutes(
  queued: number,
  maxConcurrent: number,
  avgMs: number | null,
): number | null {
  if (queued <= 0 || avgMs == null || avgMs <= 0) return null
  const concurrency = Math.max(1, maxConcurrent)
  const etaMs = Math.ceil(queued / concurrency) * avgMs
  return Math.max(1, Math.ceil(etaMs / 60_000))
}
