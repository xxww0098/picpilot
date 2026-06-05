import { describe, expect, it } from 'vitest'
import { getImageApiFanoutConcurrency } from './imageApiShared'

describe('getImageApiFanoutConcurrency', () => {
  it('uses the available server slots when the queue is clear', () => {
    expect(getImageApiFanoutConcurrency({ maxConcurrent: 5, inflight: 0, queued: 0 })).toBe(5)
    expect(getImageApiFanoutConcurrency({ maxConcurrent: 5, inflight: 2, queued: 0 })).toBe(3)
  })

  it('backs off to one request when all slots are busy or requests are queued', () => {
    expect(getImageApiFanoutConcurrency({ maxConcurrent: 5, inflight: 5, queued: 0 })).toBe(1)
    expect(getImageApiFanoutConcurrency({ maxConcurrent: 5, inflight: 1, queued: 1 })).toBe(1)
  })

  it('falls back to the 6-account reserve-one default', () => {
    expect(getImageApiFanoutConcurrency()).toBe(5)
  })
})
