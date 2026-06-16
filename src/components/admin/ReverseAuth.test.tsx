// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReverseAuth from './ReverseAuth'
import {
  bulkDeleteAdminReverseAuthAccounts,
  type AdminReverseAuthAccount,
  type AdminReverseAuthStatus,
} from '../../lib/server/adminApi'
import { openDestructiveConfirm, showAppToast } from '../../lib/ui/dialog'

const queryState = vi.hoisted(() => ({
  reload: vi.fn(),
  data: {
    configured: true,
    storage: 'database' as const,
    message: null,
    accounts: [] as AdminReverseAuthAccount[],
  } satisfies AdminReverseAuthStatus,
}))

vi.mock('../../hooks/useAsyncQuery', () => ({
  useAsyncQuery: () => ({
    data: queryState.data,
    loading: false,
    error: null,
    reload: queryState.reload,
  }),
}))

vi.mock('../../lib/server/adminApi', () => ({
  bulkDeleteAdminReverseAuthAccounts: vi.fn(),
  deleteAdminReverseAuthAccount: vi.fn(),
  downloadAdminReverseAuthAccounts: vi.fn(),
  fetchAdminReverseAuth: vi.fn(),
  fetchAdminReverseAuthAccount: vi.fn(),
  fetchAdminReverseAuthCheckJob: vi.fn(),
  importAdminReverseAuthAccessToken: vi.fn(),
  startAdminReverseAuthCheckJob: vi.fn(),
  updateAdminReverseAuthAccount: vi.fn(),
  uploadAdminReverseAuthAccount: vi.fn(),
}))

vi.mock('../../lib/ui/dialog', () => ({
  openDestructiveConfirm: vi.fn(),
  openPromptDialog: vi.fn(),
  showAppToast: vi.fn(),
}))

vi.mock('../../lib/shared/userFacingText', () => ({
  getUserFacingErrorMessage: (_err: unknown, fallback: string) => fallback,
}))

vi.mock('./ReverseAuthImportPanel', () => ({
  default: () => <div data-testid="reverse-auth-import-panel" />,
}))

describe('ReverseAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryState.data = {
      configured: true,
      storage: 'database',
      message: null,
      accounts: [],
    }
    vi.mocked(bulkDeleteAdminReverseAuthAccounts).mockResolvedValue({ ok: true, deleted: [], missing: [] })
  })

  it('notes that reverse image quota period follows upstream reset_after', () => {
    render(<ReverseAuth />)

    expect(screen.getByText(/额度周期/)).toBeTruthy()
    expect(screen.getByText(/reset_after/)).toBeTruthy()
    expect(screen.getByText(/不是 PicPilot 固定的日\/周\/月额度/)).toBeTruthy()
  })

  it('bulk deletes selected imported accounts after destructive confirmation', async () => {
    queryState.data = {
      configured: true,
      storage: 'database',
      message: null,
      accounts: [
        account('first.json', 'first@example.com'),
        account('second.json', 'second@example.com'),
      ],
    }
    vi.mocked(bulkDeleteAdminReverseAuthAccounts).mockResolvedValue({
      ok: true,
      deleted: ['first.json', 'second.json'],
      missing: [],
    })

    render(<ReverseAuth />)

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 first.json' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 second.json' }))
    fireEvent.click(screen.getByRole('button', { name: '删除已选 (2)' }))

    expect(openDestructiveConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除已选逆向账号',
      confirmText: '删除已选',
    }))
    const confirmOptions = vi.mocked(openDestructiveConfirm).mock.calls[0][0]
    await confirmOptions.onConfirm()

    expect(bulkDeleteAdminReverseAuthAccounts).toHaveBeenCalledWith(['first.json', 'second.json'])
    await waitFor(() => {
      expect(queryState.reload).toHaveBeenCalled()
    })
    expect(showAppToast).toHaveBeenCalledWith('已删除 2 个逆向账号。', 'success')
  })
})

function account(name: string, email: string): AdminReverseAuthAccount {
  return {
    name,
    email,
    hasRefreshToken: true,
    disabled: false,
    successCount: 0,
    failCount: 0,
    size: 1024,
    modifiedAt: Date.now(),
  }
}
