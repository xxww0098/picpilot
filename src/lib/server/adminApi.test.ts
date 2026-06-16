import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_TOKEN_KEY } from '../shared/auth'
import {
  downloadAdminReverseAuthAccounts,
  fetchAdminReverseAuthImportSources,
  fetchAdminReverseAuthAccount,
  fetchAdminReverseAuthCheckJob,
  fetchAdminReverseAuthCLIProxyAccounts,
  saveAdminReverseAuthImportSources,
  importAdminReverseAuthCLIProxyAccounts,
  importAdminReverseAuthAccessToken,
  importAdminReverseAuthSub2APIAccounts,
  patchAdminTeamSettings,
  startAdminReverseAuthCheckJob,
  updateAdminReverseAuthAccount,
} from './adminApi'

describe('adminApi team settings', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends outbound proxy settings in the team-settings patch body', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      defaultMaxBatchImages: 10,
      galleryAutoRetryCount: 1,
      maxConcurrent: 5,
      maxQueue: 10,
      proxyUserSoftLimit: 3,
      reverseAccountConcurrency: 1,
      streamFallbackEnabled: true,
      requestTimeoutSeconds: 900,
      allowedOutputFormats: ['jpeg', 'png'],
      outboundProxyType: 'socks5h',
      outboundProxyUrl: '127.0.0.1:1080',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await patchAdminTeamSettings({
      outboundProxyType: 'socks5h',
      outboundProxyUrl: '127.0.0.1:1080',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/team-settings', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({
      outboundProxyType: 'socks5h',
      outboundProxyUrl: '127.0.0.1:1080',
    })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('sends allowed output formats in the team-settings patch body', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      defaultMaxBatchImages: 10,
      galleryAutoRetryCount: 1,
      maxConcurrent: 5,
      maxQueue: 10,
      proxyUserSoftLimit: 3,
      reverseAccountConcurrency: 1,
      streamFallbackEnabled: true,
      requestTimeoutSeconds: 900,
      allowedOutputFormats: ['jpeg', 'webp'],
      outboundProxyType: 'env',
      outboundProxyUrl: '',
      cliproxyApiUrl: '',
      cliproxyManagementKeyConfigured: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await patchAdminTeamSettings({ allowedOutputFormats: ['jpeg', 'webp'] })

    expect(result.allowedOutputFormats).toEqual(['jpeg', 'webp'])
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/team-settings', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ allowedOutputFormats: ['jpeg', 'webp'] })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('sends cliproxy CPA server settings in the team-settings patch body', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      defaultMaxBatchImages: 10,
      galleryAutoRetryCount: 1,
      maxConcurrent: 5,
      maxQueue: 10,
      proxyUserSoftLimit: 3,
      reverseAccountConcurrency: 1,
      streamFallbackEnabled: true,
      requestTimeoutSeconds: 900,
      outboundProxyType: 'env',
      outboundProxyUrl: '',
      cliproxyApiUrl: 'http://cliproxy:8317',
      cliproxyManagementKeyConfigured: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await patchAdminTeamSettings({
      cliproxyApiUrl: 'http://cliproxy:8317',
      cliproxyManagementKey: 'mgmt-secret',
    })

    expect(result.cliproxyManagementKeyConfigured).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/team-settings', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({
      cliproxyApiUrl: 'http://cliproxy:8317',
      cliproxyManagementKey: 'mgmt-secret',
    })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('sends reverse account concurrency in the team-settings patch body', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      defaultMaxBatchImages: 10,
      galleryAutoRetryCount: 1,
      maxConcurrent: 5,
      maxQueue: 10,
      proxyUserSoftLimit: 3,
      reverseAccountConcurrency: 2,
      streamFallbackEnabled: true,
      requestTimeoutSeconds: 900,
      outboundProxyType: 'env',
      outboundProxyUrl: '',
      cliproxyApiUrl: '',
      cliproxyManagementKeyConfigured: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await patchAdminTeamSettings({ reverseAccountConcurrency: 2 })

    expect(result.reverseAccountConcurrency).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/team-settings', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ reverseAccountConcurrency: 2 })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('starts and fetches reverse auth check jobs', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: {
          id: 'rac-1',
          status: 'running',
          total: 2,
          completed: 0,
          startedAt: 1800000000000,
          updatedAt: 1800000000000,
          results: [],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: {
          id: 'rac-1',
          status: 'succeeded',
          total: 2,
          completed: 2,
          startedAt: 1800000000000,
          updatedAt: 1800000001000,
          finishedAt: 1800000001000,
          results: [
            { name: 'first.json', status: 'ok', checkedAt: 1800000000500 },
            { name: 'second.json', status: 'quota_or_rate_limited', checkedAt: 1800000000900 },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const started = await startAdminReverseAuthCheckJob()
    const final = await fetchAdminReverseAuthCheckJob(started.job.id)

    expect(started.job.status).toBe('running')
    expect(final.job.completed).toBe(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/reverse-auth/check-jobs')
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/reverse-auth/check-jobs/rac-1')
  })

  it('normalizes null reverse auth check job results to empty arrays', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: {
          id: 'rac-empty',
          status: 'running',
          total: 0,
          completed: 0,
          startedAt: 1800000000000,
          updatedAt: 1800000000000,
          results: null,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: {
          id: 'rac-empty',
          status: 'succeeded',
          total: 0,
          completed: 0,
          startedAt: 1800000000000,
          updatedAt: 1800000001000,
          finishedAt: 1800000001000,
          results: null,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const started = await startAdminReverseAuthCheckJob()
    const final = await fetchAdminReverseAuthCheckJob(started.job.id)

    expect(started.job.results).toEqual([])
    expect(final.job.results).toEqual([])
  })

  it('starts reverse auth check jobs for selected account names', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      job: {
        id: 'rac-selected',
        status: 'running',
        total: 2,
        completed: 0,
        startedAt: 1800000000000,
        updatedAt: 1800000000000,
        results: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await startAdminReverseAuthCheckJob(['second.json', 'first.json'])

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/reverse-auth/check-jobs', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ names: ['second.json', 'first.json'] })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('fetches and updates a reverse auth account raw json', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        account: {
          name: 'first.json',
          email: 'first@example.com',
          hasRefreshToken: true,
          disabled: false,
          successCount: 0,
          failCount: 0,
          size: 64,
          modifiedAt: 1800000000000,
        },
        rawJson: '{"email":"first@example.com","access_token":"tok_1"}',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        account: {
          name: 'first.json',
          email: 'new@example.com',
          hasRefreshToken: false,
          disabled: false,
          successCount: 0,
          failCount: 0,
          size: 58,
          modifiedAt: 1800000001000,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const raw = await fetchAdminReverseAuthAccount('first.json')
    const updated = await updateAdminReverseAuthAccount('first.json', '{"email":"new@example.com","access_token":"tok_new"}')

    expect(raw.rawJson).toContain('tok_1')
    expect(updated.account.email).toBe('new@example.com')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/reverse-auth/accounts/first.json')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/reverse-auth/accounts/first.json')
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ rawJson: '{"email":"new@example.com","access_token":"tok_new"}' })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('imports a reverse auth access token', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      account: {
        name: 'access-token.json',
        email: '',
        hasRefreshToken: false,
        disabled: false,
        successCount: 0,
        failCount: 0,
        size: 38,
        modifiedAt: 1800000000000,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await importAdminReverseAuthAccessToken({ accessToken: 'tok_pasted', name: 'access-token' })

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/reverse-auth/accounts/access-token', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ accessToken: 'tok_pasted', name: 'access-token' })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('lists and imports reverse auth accounts from a configured CLIProxy CPA server', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accounts: [
          { name: 'openai-plus.json', provider: 'openai', type: 'oauth' },
          { name: 'codex-team.json', provider: 'codex', type: 'oauth' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        imported: [
          {
            name: 'openai-plus.json',
            email: 'plus@example.com',
            hasRefreshToken: true,
            disabled: false,
            successCount: 0,
            failCount: 0,
            size: 128,
            modifiedAt: 1800000000000,
          },
        ],
        skipped: [{ name: 'codex-team.json', reason: '不是 OpenAI OAuth 账号文件。' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const listed = await fetchAdminReverseAuthCLIProxyAccounts()
    const imported = await importAdminReverseAuthCLIProxyAccounts(['openai-plus.json', 'codex-team.json'])

    expect(listed.accounts.map((account) => account.name)).toEqual(['openai-plus.json', 'codex-team.json'])
    expect(imported.imported).toHaveLength(1)
    expect(imported.skipped).toEqual([{ name: 'codex-team.json', reason: '不是 OpenAI OAuth 账号文件。' }])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/reverse-auth/cliproxy/accounts')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/reverse-auth/cliproxy/import')
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ names: ['openai-plus.json', 'codex-team.json'] })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('saves reverse auth import sources without expecting returned secrets', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sources: [
          {
            id: 'cpa-main',
            type: 'cpa',
            name: 'Main CPA',
            baseUrl: 'https://cpa.example.com',
            managementKeyConfigured: true,
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sources: [
          {
            id: 'cpa-main',
            type: 'cpa',
            name: 'Main CPA',
            baseUrl: 'https://cpa.example.com',
            managementKeyConfigured: true,
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const saved = await saveAdminReverseAuthImportSources([
      {
        id: 'cpa-main',
        type: 'cpa',
        name: 'Main CPA',
        baseUrl: 'https://cpa.example.com',
        managementKey: 'cpa-secret',
      },
    ])
    const listed = await fetchAdminReverseAuthImportSources()

    expect(saved.sources[0].managementKeyConfigured).toBe(true)
    expect(listed.sources[0].managementKeyConfigured).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/reverse-auth/sources')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({
      sources: [{
        id: 'cpa-main',
        type: 'cpa',
        name: 'Main CPA',
        baseUrl: 'https://cpa.example.com',
        managementKey: 'cpa-secret',
      }],
    })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/reverse-auth/sources')
  })

  it('passes a source id when listing and importing CPA accounts', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accounts: [{ name: 'openai-plus.json', provider: 'openai', type: 'oauth' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        imported: [],
        skipped: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await fetchAdminReverseAuthCLIProxyAccounts('cpa-main')
    await importAdminReverseAuthCLIProxyAccounts(['openai-plus.json'], 'cpa-main')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/reverse-auth/cliproxy/accounts?sourceId=cpa-main')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/reverse-auth/cliproxy/import')
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      sourceId: 'cpa-main',
      names: ['openai-plus.json'],
    })
  })

  it('imports reverse auth accounts from a sub2api server with filters', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      imported: [
        {
          name: 'sub2api-plus.json',
          email: 'plus@example.com',
          hasRefreshToken: true,
          disabled: false,
          successCount: 0,
          failCount: 0,
          size: 128,
          modifiedAt: 1800000000000,
        },
      ],
      skipped: [{ name: 'claude-key', reason: '不是 OpenAI 账号。' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await importAdminReverseAuthSub2APIAccounts({
      sourceId: 'sub-main',
      baseUrl: 'https://sub2api.example.com',
      adminToken: 'sub-secret',
      search: 'plus',
      status: 'active',
    })

    expect(result.imported).toHaveLength(1)
    expect(result.skipped).toEqual([{ name: 'claude-key', reason: '不是 OpenAI 账号。' }])
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/reverse-auth/sub2api/import', expect.any(Object))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      sourceId: 'sub-main',
      baseUrl: 'https://sub2api.example.com',
      adminToken: 'sub-secret',
      search: 'plus',
      status: 'active',
    })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('downloads reverse auth accounts as json', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'test-token')
    const revokeObjectURL = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:reverse-auth')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const click = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ click })),
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      exportedAt: 1800000000000,
      accounts: [{ name: 'first.json', rawJson: '{"access_token":"tok"}' }],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="picpilot-reverse-auth-20260609-120000.json"',
      },
    }))

    await downloadAdminReverseAuthAccounts()

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/reverse-auth/accounts/export', expect.any(Object))
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:reverse-auth')
  })
})
