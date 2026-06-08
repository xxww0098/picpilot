import { authJson, readErrorMessage } from './apiClient'
import { authFetch } from './auth'

export interface AdminOverviewData {
  totals: {
    total: number
    success: number
    failure: number
    avg_duration: number | null
    total_output: number | null
  }
  errors: Array<{ error_type: string; n: number }>
  providers: Array<{ provider: string; n: number }>
}

export interface AdminUserRow {
  id: string
  username: string
  is_admin: number
  disabled: number
  max_batch_images: number
  created_at: number
  last_login_at: number | null
  avatar_updated_at: number | null
  total_requests: number | null
  success_count: number | null
  failure_count: number | null
  last_request_at: number | null
  total_duration_ms: number | null
  total_output_bytes: number | null
}

export interface AdminTeamSettings {
  defaultMaxBatchImages: number
  galleryAutoRetryCount: number
  maxConcurrent: number
  maxQueue: number
  proxyUserSoftLimit: number
  streamFallbackEnabled: boolean
  requestTimeoutSeconds: number
}

export interface AdminInviteRedemption {
  user_id: string
  username: string | null
  redeemed_at: number
}

export interface AdminInviteRow {
  code: string
  created_by: string
  creator_username: string | null
  created_at: number
  expires_at: number | null
  max_uses: number
  used_count: number
  note: string | null
  redemptions: AdminInviteRedemption[]
}

export interface AdminEventRow {
  id: number
  user_id: string
  username: string
  event_type: string
  app_mode: string | null
  provider: string | null
  api_mode: string | null
  model: string | null
  size: string | null
  quality: string | null
  n_images: number | null
  has_input_image: number | null
  has_mask: number | null
  prompt: string | null
  duration_ms: number | null
  http_status: number | null
  error_type: string | null
  error_message: string | null
  error_stack: string | null
  output_count: number | null
  output_bytes: number | null
  action_type: string | null
  task_id: string | null
  image_index: number | null
  user_agent: string | null
  ip: string | null
  client_version: string | null
  created_at: number
}

export interface AdminFailureSummary {
  range: { since: number; until: number }
  totals: Array<{
    app_mode: string
    total: number
    success: number
    failure: number
    avg_duration: number | null
  }>
  reasons: Array<{
    reason: string
    app_mode: string
    error_type: string | null
    http_status: number | null
    count: number
    latest_at: number
    sample_message: string | null
  }>
  statuses: Array<{ http_status: number | null; count: number }>
  users: Array<{ username: string; failures: number; latest_at: number }>
}

export interface AdminUpstreamHealth {
  available: boolean
  logDir: string | null
  message?: string
  scannedBytes: number
  generatedAt: number
  accounts: Array<{
    accountKey: string
    label: string
    provider: string
    total: number
    success: number
    failure: number
    failureRate: number
    avgDurationMs: number | null
    lastSeenAt: number | null
    models: string[]
    routes: Array<{ route: string; total: number; failure: number }>
    status: 'healthy' | 'watch' | 'isolate'
    recommendation: string
  }>
}

export function fetchAdminOverview() {
  return authJson<AdminOverviewData>('/api/admin/overview', undefined, '加载失败')
}

export function fetchAdminUsers() {
  return authJson<{ users: AdminUserRow[] }>('/api/admin/users', undefined, '加载失败')
}

export function fetchAdminTeamSettings() {
  return authJson<AdminTeamSettings>('/api/admin/team-settings', undefined, '加载失败')
}

export function patchAdminTeamSettings(body: {
  defaultMaxBatchImages?: number
  galleryAutoRetryCount?: number
  maxConcurrent?: number
  maxQueue?: number
  proxyUserSoftLimit?: number
  streamFallbackEnabled?: boolean
  requestTimeoutSeconds?: number
}) {
  return authJson<AdminTeamSettings>('/api/admin/team-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, '保存失败')
}

export function patchAdminUser(id: string, body: { isAdmin?: boolean; password?: string; disabled?: boolean }) {
  return authJson<{ ok: true }>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, '操作失败')
}

export function deleteAdminUser(id: string) {
  return authJson<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' }, '删除失败')
}

export function fetchAdminInvites() {
  return authJson<{ invites: AdminInviteRow[] }>('/api/admin/invites', undefined, '加载失败')
}

export function createAdminInvite(body: Record<string, unknown>) {
  return authJson<{ code: string; codes: string[] }>('/api/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, '生成失败')
}

export function deleteAdminInvite(code: string) {
  return authJson<{ ok: true }>(`/api/admin/invites/${code}`, { method: 'DELETE' }, '吊销失败')
}

export function fetchAdminEvents(params: URLSearchParams) {
  return authJson<{ events: AdminEventRow[]; total: number }>(`/api/admin/events?${params}`, undefined, '加载失败')
}

export function fetchAdminFailureSummary(params = new URLSearchParams()) {
  const query = params.toString()
  return authJson<AdminFailureSummary>(`/api/admin/failure-summary${query ? `?${query}` : ''}`, undefined, '加载失败')
}

export function fetchAdminUpstreamHealth() {
  return authJson<AdminUpstreamHealth>('/api/admin/upstream-health', undefined, '加载失败')
}

export async function downloadAdminDiagnostics(): Promise<void> {
  const res = await authFetch('/api/admin/diagnostics/export')
  if (!res.ok) throw new Error(await readErrorMessage(res, '导出诊断包失败'))
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/i)
  const filename = match?.[1] ?? `picpilot-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function downloadAdminEventsCsv(params: URLSearchParams): Promise<void> {
  const res = await authFetch(`/api/admin/events/export?${params}`)
  if (!res.ok) throw new Error(await readErrorMessage(res, '导出失败'))
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/i)
  const filename = match?.[1] ?? `picpilot-events-${new Date().toISOString().slice(0, 10)}.csv`
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
