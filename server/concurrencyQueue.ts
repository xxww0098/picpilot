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

export interface ConcurrencyQueue {
  /**
   * 获取一个并发槽位。有空位且无人排队时立即放行；否则进入 FIFO 队列等待。
   * 队满抛 QueueFullError，等待超时抛 QueueWaitTimeoutError，
   * 客户端中途断开抛 ClientAbortError。成功后调用方必须在结束时调用 release()。
   */
  acquire(signal: AbortSignal, maxWaitMs?: number): Promise<void>
  /** 释放一个并发槽位并唤醒队首等待者。 */
  release(): void
  /** 当前在途数与排队数，用于日志/调试。 */
  stats(): { inflight: number; queued: number }
}

interface SlotWaiter {
  resolve: () => void
  reject: (err: Error) => void
}

export function createConcurrencyQueue(opts: ConcurrencyQueueOptions): ConcurrencyQueue {
  const maxConcurrent = Math.max(1, opts.maxConcurrent)
  const maxQueue = Math.max(0, opts.maxQueue)
  const defaultWaitMs = Math.max(0, opts.maxWaitMs)

  let inflight = 0
  const waiters: SlotWaiter[] = []

  function acquire(signal: AbortSignal, maxWaitMs: number = defaultWaitMs): Promise<void> {
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
      const waiter: SlotWaiter = {
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

  function release(): void {
    inflight--
    // 唤醒队首等待者；resolve 内部会 inflight++。
    while (waiters.length > 0 && inflight < maxConcurrent) {
      waiters.shift()!.resolve()
    }
  }

  return {
    acquire,
    release,
    stats: () => ({ inflight, queued: waiters.length }),
  }
}
