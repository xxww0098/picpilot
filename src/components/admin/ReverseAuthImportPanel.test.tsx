// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReverseAuthImportPanel from './ReverseAuthImportPanel'
import {
  fetchAdminReverseAuthCLIProxyAccounts,
  fetchAdminReverseAuthImportSources,
  saveAdminReverseAuthImportSources,
} from '../../lib/server/adminApi'

vi.mock('../../lib/server/adminApi', () => ({
  fetchAdminReverseAuthImportSources: vi.fn(),
  saveAdminReverseAuthImportSources: vi.fn(),
  fetchAdminReverseAuthCLIProxyAccounts: vi.fn(),
  importAdminReverseAuthCLIProxyAccounts: vi.fn(),
  importAdminReverseAuthSub2APIAccounts: vi.fn(),
}))

vi.mock('../../lib/ui/dialog', () => ({
  showAppToast: vi.fn(),
}))

vi.mock('../../lib/shared/userFacingText', () => ({
  getUserFacingErrorMessage: (_err: unknown, fallback: string) => fallback,
}))

describe('ReverseAuthImportPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchAdminReverseAuthImportSources).mockResolvedValue({
      sources: [
        {
          id: 'cpa-main',
          type: 'cpa',
          name: 'Main CPA',
          baseUrl: 'https://cpa.example.com',
          managementKeyConfigured: true,
        },
        {
          id: 'sub-main',
          type: 'sub2api',
          name: 'Main Sub2API',
          baseUrl: 'https://sub.example.com',
          managementKeyConfigured: true,
        },
      ],
    })
    vi.mocked(saveAdminReverseAuthImportSources).mockImplementation(async (sources) => ({
      sources: sources.map((source) => ({ ...source, managementKeyConfigured: Boolean(source.managementKeyConfigured || source.managementKey) })),
    }))
    vi.mocked(fetchAdminReverseAuthCLIProxyAccounts).mockResolvedValue({
      accounts: [{ name: 'openai-plus.json', provider: 'openai', type: 'oauth' }],
    })
  })

  it('loads saved CPA and Sub2API sources and reads CPA accounts by source id', async () => {
    render(<ReverseAuthImportPanel disabled={false} onImported={vi.fn()} />)

    expect(await screen.findByDisplayValue('Main CPA')).toBeTruthy()
    expect(screen.getByDisplayValue('Main Sub2API')).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加 CPA' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加 Sub2API' })).toBeTruthy()
    expect(screen.getByText(/同名导入会覆盖已存在的逆向账号信息/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '读取 Main CPA' }))

    await waitFor(() => {
      expect(fetchAdminReverseAuthCLIProxyAccounts).toHaveBeenCalledWith('cpa-main')
    })
    expect(await screen.findByText('openai-plus.json')).toBeTruthy()
  })

  it('shows a hint when CPA address uses the legacy cliproxy hostname', async () => {
    vi.mocked(fetchAdminReverseAuthImportSources).mockResolvedValue({
      sources: [{
        id: 'cpa-main',
        type: 'cpa',
        name: 'Main CPA',
        baseUrl: 'http://cliproxy:8317',
        managementKeyConfigured: false,
      }],
    })

    render(<ReverseAuthImportPanel disabled={false} onImported={vi.fn()} />)

    expect(await screen.findByText(/服务名是 cliproxyapi/)).toBeTruthy()
  })
})
