// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TeamSettings from './TeamSettings'

vi.mock('../../hooks/useAsyncQuery', () => ({
  useAsyncQuery: () => ({
    data: {
      defaultMaxBatchImages: 10,
      galleryAutoRetryCount: 1,
      maxConcurrent: 5,
      maxQueue: 10,
      proxyUserSoftLimit: 3,
      reverseAccountConcurrency: 4,
      streamFallbackEnabled: true,
      requestTimeoutSeconds: 900,
      outboundProxyType: 'env',
      outboundProxyUrl: '',
      cliproxyApiUrl: '',
      cliproxyManagementKeyConfigured: false,
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}))

vi.mock('../../contexts/AuthProvider', () => ({
  useAuth: () => ({ patchUser: vi.fn() }),
}))

vi.mock('../../lib/adminApi', () => ({
  fetchAdminTeamSettings: vi.fn(),
  patchAdminTeamSettings: vi.fn(),
}))

vi.mock('../../lib/dialog', () => ({
  openPromptDialog: vi.fn(),
  showAppToast: vi.fn(),
}))

vi.mock('../../lib/userFacingText', () => ({
  getUserFacingErrorMessage: (_err: unknown, fallback: string) => fallback,
}))

describe('TeamSettings', () => {
  it('renders the reverse account concurrency setting', () => {
    render(<TeamSettings />)

    expect(screen.getByText('逆向单账号并发')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('个请求/账号')).toBeTruthy()
  })
})
