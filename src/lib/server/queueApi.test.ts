import { describe, expect, it } from 'vitest'
import { computeQueueEtaMinutes, getRecentAvgTaskMs } from './queueApi'

type Sample = { status: 'running' | 'done' | 'error'; elapsed: number | null }
const done = (elapsed: number | null): Sample => ({ status: 'done', elapsed })

describe('getRecentAvgTaskMs', () => {
  it('returns null when fewer than 2 valid samples', () => {
    expect(getRecentAvgTaskMs([])).toBeNull()
    expect(getRecentAvgTaskMs([done(30_000)])).toBeNull()
    expect(getRecentAvgTaskMs([done(null), { status: 'running', elapsed: null }])).toBeNull()
  })

  it('averages recent done tasks, ignoring running/error/invalid elapsed', () => {
    const tasks: Sample[] = [
      done(20_000),
      { status: 'running', elapsed: null },
      done(40_000),
      { status: 'error', elapsed: 99_000 },
    ]
    expect(getRecentAvgTaskMs(tasks)).toBe(30_000)
  })

  it('only considers up to sampleSize most-recent done tasks', () => {
    const tasks: Sample[] = [done(10_000), done(20_000), done(90_000)]
    expect(getRecentAvgTaskMs(tasks, 2)).toBe(15_000)
  })
})

describe('computeQueueEtaMinutes', () => {
  it('returns null when nothing is queued', () => {
    expect(computeQueueEtaMinutes(0, 5, 60_000)).toBeNull()
  })

  it('returns null without an average sample', () => {
    expect(computeQueueEtaMinutes(3, 5, null)).toBeNull()
  })

  it('rounds queued up by concurrency, then minutes up', () => {
    // 6 queued / 5 concurrent = 2 batches; 2 * 60s = 120s = 2 min
    expect(computeQueueEtaMinutes(6, 5, 60_000)).toBe(2)
    // 2 queued / 5 concurrent = 1 batch; 45s -> ceil to 1 min
    expect(computeQueueEtaMinutes(2, 5, 45_000)).toBe(1)
  })

  it('treats maxConcurrent < 1 as 1', () => {
    expect(computeQueueEtaMinutes(2, 0, 60_000)).toBe(2)
  })
})
