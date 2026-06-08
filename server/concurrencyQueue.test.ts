import { expect, test } from 'vitest'
import {
  createConcurrencyQueue,
  QueueFullError,
  QueueWaitTimeoutError,
  ClientAbortError,
} from './concurrencyQueue.ts'

const neverAbort = () => new AbortController().signal
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

test('空闲时立即放行，达到上限后新请求进入队列', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 2, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  await q.acquire(neverAbort())
  expect(q.stats()).toEqual({ inflight: 2, queued: 0 })

  let third = false
  const p = q.acquire(neverAbort()).then(() => { third = true })
  await tick()
  expect(third).toBe(false)
  expect(q.stats()).toEqual({ inflight: 2, queued: 1 })

  q.release() // 释放一个 → 唤醒队首
  await p
  expect(third).toBe(true)
  expect(q.stats()).toEqual({ inflight: 2, queued: 0 })
})

test('按 FIFO 顺序唤醒等待者', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())

  const order: string[] = []
  const w1 = q.acquire(neverAbort()).then(() => order.push('b'))
  const w2 = q.acquire(neverAbort()).then(() => order.push('c'))
  const w3 = q.acquire(neverAbort()).then(() => order.push('d'))
  await tick()

  q.release(); await w1
  q.release(); await w2
  q.release(); await w3
  expect(order).toEqual(['b', 'c', 'd'])
})

test('按用户返回当前 FIFO 排队位置', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort(), undefined, { userId: 'owner' })

  const b = q.acquire(neverAbort(), undefined, { userId: 'user-b' })
  const a1 = q.acquire(neverAbort(), undefined, { userId: 'user-a' })
  const a2 = q.acquire(neverAbort(), undefined, { userId: 'user-a' })
  await tick()

  expect(q.stats()).toEqual({ inflight: 1, queued: 3 })
  expect(q.stats('user-b')).toEqual({ inflight: 1, queued: 3, myInflight: 0, myQueued: 1, myNextPosition: 1 })
  expect(q.stats('user-a')).toEqual({ inflight: 1, queued: 3, myInflight: 0, myQueued: 2, myNextPosition: 2 })
  expect(q.stats('nobody')).toEqual({ inflight: 1, queued: 3, myInflight: 0, myQueued: 0, myNextPosition: null })

  q.release()
  await b
  expect(q.stats('user-a')).toEqual({ inflight: 1, queued: 2, myInflight: 0, myQueued: 2, myNextPosition: 1 })

  q.release()
  await a1
  q.release()
  await a2
  q.release()
  expect(q.stats('user-a')).toEqual({ inflight: 0, queued: 0, myInflight: 0, myQueued: 0, myNextPosition: null })
})

test('单用户软上限开启时，队首用户已超限则放行后方其他用户', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 2, maxQueue: 10, maxWaitMs: 0, perUserSoftLimit: 1 })
  await q.acquire(neverAbort(), undefined, { userId: 'user-a' })
  await q.acquire(neverAbort(), undefined, { userId: 'user-b' })

  const order: string[] = []
  const a2 = q.acquire(neverAbort(), undefined, { userId: 'user-a' }).then(() => order.push('a2'))
  const c1 = q.acquire(neverAbort(), undefined, { userId: 'user-c' }).then(() => order.push('c1'))
  await tick()

  q.release({ userId: 'user-b' })
  await c1
  expect(order).toEqual(['c1'])
  expect(q.stats('user-a')).toEqual({ inflight: 2, queued: 1, myInflight: 1, myQueued: 1, myNextPosition: 1 })

  q.release({ userId: 'user-c' })
  await a2
  expect(order).toEqual(['c1', 'a2'])
})

test('队列已满时立即抛 QueueFullError', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 1, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  void q.acquire(neverAbort()).catch(() => {}) // 占满队列（长度 1）
  await tick()
  await expect(q.acquire(neverAbort())).rejects.toBeInstanceOf(QueueFullError)
})

test('等待超时抛 QueueWaitTimeoutError 且不泄漏队列槽位', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 20 })
  await q.acquire(neverAbort())
  await expect(q.acquire(neverAbort())).rejects.toBeInstanceOf(QueueWaitTimeoutError)
  expect(q.stats()).toEqual({ inflight: 1, queued: 0 })
})

test('客户端断开时移除等待者并抛 ClientAbortError', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  const ctrl = new AbortController()
  const p = q.acquire(ctrl.signal)
  await tick()
  expect(q.stats().queued).toBe(1)
  ctrl.abort()
  await expect(p).rejects.toBeInstanceOf(ClientAbortError)
  expect(q.stats()).toEqual({ inflight: 1, queued: 0 })
})

test('进入队列前已 abort 的请求直接拒绝', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  const ctrl = new AbortController()
  ctrl.abort()
  await expect(q.acquire(ctrl.signal)).rejects.toBeInstanceOf(ClientAbortError)
  expect(q.stats().queued).toBe(0)
})

test('超时被唤醒竞态：超时拒绝后释放不会错配槽位', async () => {
  // 等待者超时后，后续 release 应只唤醒仍在队列中的等待者
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 15 })
  await q.acquire(neverAbort())
  const timedOut = q.acquire(neverAbort())
  await expect(timedOut).rejects.toBeInstanceOf(QueueWaitTimeoutError)

  let cResolved = false
  const c = q.acquire(neverAbort()).then(() => { cResolved = true })
  await tick()
  q.release()
  await c
  expect(cResolved).toBe(true)
  expect(q.stats()).toEqual({ inflight: 1, queued: 0 })
})

test('过量 release 不会让 inflight 变负，且不破坏后续放行', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 2, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  q.release()
  q.release() // 越界释放：被下限守卫忽略，inflight 不应变负
  expect(q.stats()).toEqual({ inflight: 0, queued: 0 })

  // 越界释放后并发上限依然准确：能再放行 2 个，第 3 个进队列
  await q.acquire(neverAbort())
  await q.acquire(neverAbort())
  expect(q.stats().inflight).toBe(2)
  let third = false
  void q.acquire(neverAbort()).then(() => { third = true })
  await tick()
  expect(third).toBe(false)
  expect(q.stats()).toEqual({ inflight: 2, queued: 1 })
})

test('setLimits 提高 maxConcurrent 立即唤醒等待者', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  let woken = false
  const p = q.acquire(neverAbort()).then(() => { woken = true })
  await tick()
  expect(woken).toBe(false)
  expect(q.stats()).toEqual({ inflight: 1, queued: 1 })

  q.setLimits({ maxConcurrent: 2 }) // 腾出空位 → 队首立即放行
  await p
  expect(woken).toBe(true)
  expect(q.limits()).toEqual({ maxConcurrent: 2, maxQueue: 10, perUserSoftLimit: 0 })
  expect(q.stats()).toEqual({ inflight: 2, queued: 0 })
})

test('setLimits 降低 maxConcurrent 不中断在途，只影响后续放行', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 3, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  await q.acquire(neverAbort())
  await q.acquire(neverAbort())
  q.setLimits({ maxConcurrent: 1 }) // 已在途的 3 个不受影响
  expect(q.stats()).toEqual({ inflight: 3, queued: 0 })

  let next = false
  void q.acquire(neverAbort()).then(() => { next = true })
  await tick()
  expect(next).toBe(false) // inflight(3) 仍 >= 新上限(1)，必须排队
  expect(q.stats()).toEqual({ inflight: 3, queued: 1 })
})

test('setLimits 调小 maxQueue 后新请求按新上限拒绝', async () => {
  const q = createConcurrencyQueue({ maxConcurrent: 1, maxQueue: 10, maxWaitMs: 0 })
  await q.acquire(neverAbort())
  q.setLimits({ maxQueue: 1 })
  void q.acquire(neverAbort()).catch(() => {}) // 占满新队列（长度 1）
  await tick()
  await expect(q.acquire(neverAbort())).rejects.toBeInstanceOf(QueueFullError)
})
