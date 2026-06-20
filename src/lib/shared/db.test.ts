// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateStorageUsage, isStoragePersisted, requestPersistentStorage } from './db'

type StorageMock = {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

function setStorage(mock: StorageMock | undefined) {
  Object.defineProperty(navigator, 'storage', { value: mock, configurable: true, writable: true })
}

afterEach(() => {
  setStorage(undefined)
  vi.restoreAllMocks()
})

describe('storage durability helpers', () => {
  it('returns true without re-requesting when already persisted', async () => {
    const persist = vi.fn().mockResolvedValue(false)
    setStorage({ persisted: () => Promise.resolve(true), persist })
    expect(await requestPersistentStorage()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('requests persistence when not yet persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    setStorage({ persisted: () => Promise.resolve(false), persist })
    expect(await requestPersistentStorage()).toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('returns false (no throw) when the StorageManager API is unavailable', async () => {
    setStorage(undefined)
    expect(await requestPersistentStorage()).toBe(false)
  })

  it('isStoragePersisted reflects the API and swallows errors', async () => {
    setStorage({ persisted: () => Promise.resolve(true) })
    expect(await isStoragePersisted()).toBe(true)
    setStorage({ persisted: () => Promise.reject(new Error('blocked')) })
    expect(await isStoragePersisted()).toBe(false)
  })

  it('computes percentUsed from usage/quota', async () => {
    setStorage({
      persisted: () => Promise.resolve(true),
      estimate: () => Promise.resolve({ usage: 250, quota: 1000 }),
    })
    const info = await estimateStorageUsage()
    expect(info).toEqual({ usageBytes: 250, quotaBytes: 1000, percentUsed: 25, persisted: true })
  })

  it('degrades to zeros when the API is unavailable', async () => {
    setStorage(undefined)
    expect(await estimateStorageUsage()).toEqual({
      usageBytes: 0,
      quotaBytes: 0,
      percentUsed: 0,
      persisted: false,
    })
  })
})
