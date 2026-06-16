// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TeamSettings from './TeamSettings'

afterEach(() => {
  cleanup()
})

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
      allowedOutputFormats: ['jpeg', 'png'],
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

vi.mock('../../lib/server/adminApi', () => ({
  fetchAdminTeamSettings: vi.fn(),
  patchAdminTeamSettings: vi.fn(),
}))

vi.mock('../../lib/ui/dialog', () => ({
  openPromptDialog: vi.fn(),
  showAppToast: vi.fn(),
}))

vi.mock('../../lib/shared/userFacingText', () => ({
  getUserFacingErrorMessage: (_err: unknown, fallback: string) => fallback,
}))

describe('TeamSettings', () => {
  it('renders the reverse account concurrency setting', () => {
    render(<TeamSettings />)

    expect(screen.getByText('逆向单账号并发')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('个请求/账号')).toBeTruthy()
  })

  it('renders allowed output formats in team settings', () => {
    render(<TeamSettings />)

    expect(screen.getAllByText('可选出图格式').length).toBeGreaterThan(0)
    expect(screen.getAllByText('JPEG / PNG').length).toBeGreaterThan(0)
  })
})
