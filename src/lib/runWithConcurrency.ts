/**
 * 以最多 limit 个并发运行一批异步任务，按加入顺序取任务。
 * 在全部任务结算后 resolve；单个任务抛错不会中断其余任务（错误由 worker 内部或此处吞掉）。
 *
 * 用于限制「一次性 fire 大量 ensureImageCached」造成的并发解码/请求峰值。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const max = Math.max(1, Math.floor(limit))
  let cursor = 0
  async function runner(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      try {
        await worker(items[index], index)
      } catch {
        // 单个任务失败不影响其余任务
      }
    }
  }
  const runners = Array.from({ length: Math.min(max, items.length) }, () => runner())
  await Promise.all(runners)
}

/**
 * Promise.allSettled with a concurrency cap, preserving result order.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const max = Math.max(1, Math.floor(limit))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let cursor = 0

  async function runner(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const runners = Array.from({ length: Math.min(max, items.length) }, () => runner())
  await Promise.all(runners)
  return results
}
