import { DEFAULT_IMAGE_API_FANOUT_CONCURRENCY, getImageApiFanoutConcurrency, type ImageApiFanoutLoadSnapshot } from './imageApiShared'
import { fetchQueueStats } from '../server/queueApi'

type PendingRequest<T = unknown> = {
  worker: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  abortListener?: () => void
}

export type FrontendImageRequestSchedulerOptions = {
  maxLocalConcurrent?: number
  loadSnapshot?: () => Promise<ImageApiFanoutLoadSnapshot>
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/**
 * Browser-local admission control for image generation calls.
 *
 * The backend queue remains the source of truth, but the browser must not let
 * many cards/fan-outs independently observe the same free slots and stampede
 * them. This scheduler serializes admission decisions and caps local burst size.
 */
export class FrontendImageRequestScheduler {
  private active = 0
  private draining = false
  private readonly queue: PendingRequest[] = []
  private readonly maxLocalConcurrent: number
  private readonly loadSnapshot?: () => Promise<ImageApiFanoutLoadSnapshot>

  constructor(options: FrontendImageRequestSchedulerOptions = {}) {
    this.maxLocalConcurrent = normalizePositiveInteger(
      options.maxLocalConcurrent,
      DEFAULT_IMAGE_API_FANOUT_CONCURRENCY,
    )
    this.loadSnapshot = options.loadSnapshot
  }

  get activeCount(): number {
    return this.active
  }

  get queuedCount(): number {
    return this.queue.length
  }

  run<T>(worker: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(createAbortError())

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<T> = {
        worker,
        resolve,
        reject,
        signal: options.signal,
      }
      if (options.signal) {
        pending.abortListener = () => {
          const index = this.queue.indexOf(pending as PendingRequest)
          if (index >= 0) {
            this.queue.splice(index, 1)
            reject(createAbortError())
          }
        }
        options.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
      this.queue.push(pending as PendingRequest)
      this.requestDrain()
    })
  }

  private requestDrain() {
    if (this.draining) return
    this.draining = true
    void this.drain()
  }

  private async drain() {
    try {
      while (this.queue.length > 0) {
        this.dropAbortedHead()
        if (this.queue.length === 0) return

        const limit = await this.resolveCurrentLimit()
        if (this.active >= limit) return

        const pending = this.queue.shift()
        if (!pending) return
        if (pending.abortListener && pending.signal) {
          pending.signal.removeEventListener('abort', pending.abortListener)
        }
        if (pending.signal?.aborted) {
          pending.reject(createAbortError())
          continue
        }
        this.start(pending)
      }
    } finally {
      this.draining = false
    }
  }

  private dropAbortedHead() {
    while (this.queue[0]?.signal?.aborted) {
      const pending = this.queue.shift()
      if (!pending) continue
      if (pending.abortListener && pending.signal) {
        pending.signal.removeEventListener('abort', pending.abortListener)
      }
      pending.reject(createAbortError())
    }
  }

  private async resolveCurrentLimit(): Promise<number> {
    if (!this.loadSnapshot) return this.maxLocalConcurrent
    try {
      const remoteLimit = getImageApiFanoutConcurrency(await this.loadSnapshot())
      return Math.max(1, Math.min(this.maxLocalConcurrent, remoteLimit))
    } catch {
      return this.maxLocalConcurrent
    }
  }

  private start<T>(pending: PendingRequest<T>) {
    this.active++
    void pending.worker()
      .then(pending.resolve, pending.reject)
      .finally(() => {
        this.active--
        this.requestDrain()
      })
  }
}

export const globalImageRequestScheduler = new FrontendImageRequestScheduler({
  loadSnapshot: fetchQueueStats,
})

export function scheduleImageApiRequest<T>(worker: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  return globalImageRequestScheduler.run(worker, options)
}
