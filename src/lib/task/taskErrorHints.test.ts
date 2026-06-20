import { describe, expect, it, vi, afterEach } from 'vitest'
import { getApiRequestNetworkErrorHint, isFetchNetworkError } from './taskErrorHints'

describe('isFetchNetworkError', () => {
  it('detects Chrome network error', () => {
    expect(isFetchNetworkError(new TypeError('network error'))).toBe(true)
  })

  it('detects Failed to fetch', () => {
    expect(isFetchNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })
})

describe('getApiRequestNetworkErrorHint', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null for non-network errors', () => {
    expect(getApiRequestNetworkErrorHint(new Error('HTTP 429'), Date.now(), true, null)).toBeNull()
  })

  it('recognizes Chrome TypeError: network error at ~189s', () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    vi.advanceTimersByTime(189_000)
    const hint = getApiRequestNetworkErrorHint(new TypeError('network error'), startedAt, true, {
      provider: 'openai',
      apiMode: 'responses',
      streamImages: true,
      streamPartialImages: 0,
      timeout: 900,
    })
    expect(hint).toMatch(/约 189 秒/)
    expect(hint).toMatch(/180|600/)
  })

  it('suggests team timeout when elapsed is near configured profile timeout', () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    vi.advanceTimersByTime(182_000)
    const hint = getApiRequestNetworkErrorHint(new TypeError('network error'), startedAt, true, {
      provider: 'openai',
      apiMode: 'responses',
      streamImages: true,
      streamPartialImages: 2,
      timeout: 180,
    })
    expect(hint).toMatch(/180 秒/)
    expect(hint).toMatch(/团队/)
  })
})
