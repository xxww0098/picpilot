import { describe, expect, it } from 'vitest'
import { FrontendImageRequestScheduler } from './imageRequestScheduler'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('FrontendImageRequestScheduler', () => {
  it('limits concurrent image requests across independent callers', async () => {
    const scheduler = new FrontendImageRequestScheduler({
      maxLocalConcurrent: 2,
      loadSnapshot: async () => ({ maxConcurrent: 10, inflight: 0, queued: 0 }),
    })
    let active = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        scheduler.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(5)
          active--
          return index
        }),
      ),
    )

    expect(peak).toBe(2)
  })

  it('drops to one local request while the backend already has a queue', async () => {
    const scheduler = new FrontendImageRequestScheduler({
      maxLocalConcurrent: 5,
      loadSnapshot: async () => ({ maxConcurrent: 10, inflight: 3, queued: 2 }),
    })
    let active = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 3 }, () =>
        scheduler.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(5)
          active--
        }),
      ),
    )

    expect(peak).toBe(1)
  })

  it('honors the backend remaining capacity below the local cap', async () => {
    const scheduler = new FrontendImageRequestScheduler({
      maxLocalConcurrent: 5,
      loadSnapshot: async () => ({ maxConcurrent: 10, inflight: 8, queued: 0 }),
    })
    let active = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 5 }, () =>
        scheduler.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(5)
          active--
        }),
      ),
    )

    expect(peak).toBe(2)
  })

  it('removes an aborted queued request before it starts', async () => {
    const scheduler = new FrontendImageRequestScheduler({
      maxLocalConcurrent: 1,
      loadSnapshot: async () => ({ maxConcurrent: 1, inflight: 0, queued: 0 }),
    })
    let releaseFirst: (() => void) | undefined
    const first = scheduler.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const controller = new AbortController()
    let secondStarted = false
    const second = scheduler.run(async () => {
      secondStarted = true
    }, { signal: controller.signal })

    await tick()
    controller.abort()

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(secondStarted).toBe(false)
    releaseFirst?.()
    await first
  })
})
