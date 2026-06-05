// 全局并发信号量 + FIFO 等待队列。
//
// 抽象边界：调用方只用 acquire / release。当前为单进程内存实现；将来若 auth 扩多副本，
// 仅替换内部实现（内存 → Redis 共享计数 + pub/sub 唤醒），调用方无需改动。
// 注：真正的「等待」必须留在持有该 socket 的进程内（HTTP 连接钉死在单进程），
// 因此等待队列天然是进程内状态，Redis 只承担跨进程计数与排队协调。

export class QueueFullError extends Error {
  constructor() {
    super('proxy queue is full')
    this.name = 'QueueFullError'
  }
}
export class QueueWaitTimeoutError extends Error {
  constructor() {
    super('timed out waiting in proxy queue')
    this.name = 'QueueWaitTimeoutError'
  }
}
export class ClientAbortError extends Error {
  constructor() {
    super('client aborted while queued')
    this.name = 'ClientAbortError'
  }
}

export interface ConcurrencyQueueOptions {
  /** 全局同时在途上限 */
  maxConcurrent: number
  /** 等待队列长度上限；已满时 acquire 抛 QueueFullError */
  maxQueue: number
  /** 默认排队等待上限（ms）；<=0 表示不限时。acquire 可单独覆盖 */
  maxWaitMs: number
}

export interface ConcurrencyQueueStats {
  inflight: number
  queued: number
  /** 当前用户排队中的请求数；未传 userId 时不返回。 */
  myQueued?: number
  /** 当前用户第一个等待请求在 FIFO 队列中的 1-based 位置；未排队为 null。 */
  myNextPosition?: number | null
}

export interface ConcurrencyQueue {
  /**
   * 获取一个并发槽位。有空位且无人排队时立即放行；否则进入 FIFO 队列等待。
   * 队满抛 QueueFullError，等待超时抛 QueueWaitTimeoutError，
   * 客户端中途断开抛 ClientAbortError。成功后调用方必须在结束时调用 release()。
   */
  acquire(signal: AbortSignal, maxWaitMs?: number, meta?: { userId?: string | null }): Promise<void>
  /** 释放一个并发槽位并唤醒队首等待者。 */
  release(): void
  /** 当前在途数与排队数，用于日志/调试。 */
  stats(userId?: string | null): ConcurrencyQueueStats
  /**
   * 运行时调整上限（管理端「团队服务配置」用）。只更新提供的字段。
   * 提高 maxConcurrent 会立即唤醒可放行的队首等待者；
   * 降低只影响后续放行判断，不会中断已在途的请求。
   * 调小 maxQueue 不会踢出已在队列里的等待者，只对后续 acquire 生效。
   */
  setLimits(limits: { maxConcurrent?: number; maxQueue?: number }): void
  /** 当前生效上限。 */
  limits(): { maxConcurrent: number; maxQueue: number }
}

interface SlotWaiter {
  resolve: () => void
  reject: (err: Error) => void
  userId: string | null
}

export function createConcurrencyQueue(opts: ConcurrencyQueueOptions): ConcurrencyQueue {
  let maxConcurrent = Math.max(1, opts.maxConcurrent)
  let maxQueue = Math.max(0, opts.maxQueue)
  const defaultWaitMs = Math.max(0, opts.maxWaitMs)

  let inflight = 0
  const waiters: SlotWaiter[] = []

  function acquire(
    signal: AbortSignal,
    maxWaitMs: number = defaultWaitMs,
    meta?: { userId?: string | null },
  ): Promise<void> {
    // 有空位且没有排队者：直接占位放行
    if (inflight < maxConcurrent && waiters.length === 0) {
      inflight++
      return Promise.resolve()
    }
    if (waiters.length >= maxQueue) {
      return Promise.reject(new QueueFullError())
    }
    if (signal.aborted) {
      return Promise.reject(new ClientAbortError())
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const userId = typeof meta?.userId === 'string' && meta.userId ? meta.userId : null
      const waiter: SlotWaiter = {
        userId,
        resolve: () => finish(() => { inflight++; resolve() }),
        reject: (err) => finish(() => reject(err)),
      }
      const timer = maxWaitMs > 0
        ? setTimeout(() => waiter.reject(new QueueWaitTimeoutError()), maxWaitMs)
        : null
      const onAbort = () => waiter.reject(new ClientAbortError())
      function finish(action: () => void) {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        action()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  // 在有空位时按 FIFO 唤醒队首等待者；resolve 内部会 inflight++。
  function pump(): void {
    while (waiters.length > 0 && inflight < maxConcurrent) {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve()
    }
  }

  function release(): void {
    // 防御：每个成功的 acquire 只应 release 一次（handler 侧有 released 守卫保证），
    // 正常路径不会越界；这里兜底，绝不让 inflight 变负而破坏后续放行判断。
    if (inflight <= 0) return
    inflight--
    pump()
  }

  function setLimits(limits: { maxConcurrent?: number; maxQueue?: number }): void {
    if (typeof limits.maxConcurrent === 'number' && Number.isFinite(limits.maxConcurrent)) {
      maxConcurrent = Math.max(1, Math.trunc(limits.maxConcurrent))
    }
    if (typeof limits.maxQueue === 'number' && Number.isFinite(limits.maxQueue)) {
      maxQueue = Math.max(0, Math.trunc(limits.maxQueue))
    }
    // 提高并发上限后可能腾出空位，立即唤醒等待者。
    pump()
  }

  function stats(userId?: string | null): ConcurrencyQueueStats {
    const base = { inflight, queued: waiters.length }
    const targetUserId = typeof userId === 'string' && userId ? userId : null
    if (!targetUserId) return base

    let myQueued = 0
    let myNextPosition: number | null = null
    waiters.forEach((waiter, index) => {
      if (waiter.userId !== targetUserId) return
      myQueued++
      if (myNextPosition == null) myNextPosition = index + 1
    })
    return { ...base, myQueued, myNextPosition }
  }

  return {
    acquire,
    release,
    stats,
    setLimits,
    limits: () => ({ maxConcurrent, maxQueue }),
  }
}
