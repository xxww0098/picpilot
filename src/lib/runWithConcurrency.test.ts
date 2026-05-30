import { describe, it, expect } from 'vitest'
import { runWithConcurrency } from './runWithConcurrency'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('runWithConcurrency', () => {
  it('处理全部任务且不超过并发上限', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const done: number[] = []
    let active = 0
    let peak = 0

    await runWithConcurrency(items, 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await tick(5)
      done.push(n)
      active--
    })

    expect(done.sort((a, b) => a - b)).toEqual(items)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('单个任务抛错不影响其余任务', async () => {
    const processed: number[] = []
    await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      processed.push(n)
    })
    expect(processed.sort((a, b) => a - b)).toEqual([1, 3, 4])
  })

  it('空数组直接 resolve，limit 至少为 1', async () => {
    let called = 0
    await runWithConcurrency([], 0, async () => { called++ })
    expect(called).toBe(0)
  })
})
