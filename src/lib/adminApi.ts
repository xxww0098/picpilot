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
  reverseAccountConcurrency: number
  streamFallbackEnabled: boolean
  requestTimeoutSeconds: number
  outboundProxyType: AdminOutboundProxyType
  outboundProxyUrl: string
  cliproxyApiUrl: string
  cliproxyManagementKeyConfigured: boolean
}

export type AdminOutboundProxyType = 'env' | 'none' | 'http' | 'https' | 'socks5' | 'socks5h'

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

export interface AdminReverseAuthAccount {
  name: string
  email?: string
  userId?: string
  hasRefreshToken: boolean
  hasPasswordLogin?: boolean
  disabled: boolean
  status?: AdminReverseAuthCheckStatus
  statusReason?: string
  httpStatus?: number
  accountType?: string
  quota?: number
  imageQuotaUnknown?: boolean
  restoreAt?: string
  defaultModelSlug?: string
  lastCheckedAt?: number
  lastUsedAt?: number
  successCount: number
  failCount: number
  size: number
  modifiedAt: number
}

export interface AdminReverseAuthStatus {
  configured: boolean
  storage: 'database'
  message: string | null
  accounts: AdminReverseAuthAccount[]
}

export interface AdminReverseAuthAccountRaw {
  account: AdminReverseAuthAccount
  rawJson: string
}

export interface AdminReverseAuthCLIProxyAccount {
  name: string
  provider?: string
  type?: string
}

export type AdminReverseAuthImportSourceType = 'cpa' | 'sub2api'

export interface AdminReverseAuthImportSource {
  id: string
  type: AdminReverseAuthImportSourceType
  name: string
  baseUrl: string
  managementKeyConfigured?: boolean
  managementKey?: string
}

export interface AdminReverseAuthImportSkipped {
  name: string
  reason: string
}

export interface AdminReverseAuthImportResponse {
  imported: AdminReverseAuthAccount[]
  skipped: AdminReverseAuthImportSkipped[]
}

export type AdminReverseAuthCheckStatus = 'ok' | 'quota_or_rate_limited' | 'expired' | 'invalid' | 'disabled' | 'error'

export interface AdminReverseAuthCheckResult {
  name: string
  email?: string
  userId?: string
  hasRefreshToken: boolean
  disabled: boolean
  status: AdminReverseAuthCheckStatus
  reason?: string
  httpStatus?: number
  checkedAt: number
  type?: string
  quota?: number
  imageQuotaUnknown?: boolean
  restoreAt?: string
  defaultModelSlug?: string
}

export interface AdminReverseAuthCheckResponse {
  checkedAt: number
  results: AdminReverseAuthCheckResult[]
}

export type AdminReverseAuthCheckJobStatus = 'running' | 'succeeded' | 'failed'

export interface AdminReverseAuthCheckJob {
  id: string
  status: AdminReverseAuthCheckJobStatus
  total: number
  completed: number
  startedAt: number
  updatedAt: number
  finishedAt?: number
  error?: string
  results: AdminReverseAuthCheckResult[]
}

export interface AdminReverseAuthCheckJobResponse {
  job: AdminReverseAuthCheckJob
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
  reverseAccountConcurrency?: number
  streamFallbackEnabled?: boolean
  requestTimeoutSeconds?: number
  outboundProxyType?: AdminOutboundProxyType
  outboundProxyUrl?: string
  cliproxyApiUrl?: string
  cliproxyManagementKey?: string
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

export function fetchAdminReverseAuth() {
  return authJson<AdminReverseAuthStatus>('/api/admin/reverse-auth', undefined, '加载 reverse 账号失败')
}

export function checkAdminReverseAuth() {
  return authJson<AdminReverseAuthCheckResponse>('/api/admin/reverse-auth/check', {
    method: 'POST',
  }, '检查 reverse 账号失败')
}

export function startAdminReverseAuthCheckJob(names?: string[]) {
  const selectedNames = names?.map((name) => name.trim()).filter(Boolean) ?? []
  return authJson<AdminReverseAuthCheckJobResponse>('/api/admin/reverse-auth/check-jobs', {
    method: 'POST',
    ...(selectedNames.length > 0
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: selectedNames }),
        }
      : {}),
  }, '启动 reverse 账号检查失败').then(normalizeAdminReverseAuthCheckJobResponse)
}

export function fetchAdminReverseAuthCheckJob(id: string) {
  return authJson<AdminReverseAuthCheckJobResponse>(`/api/admin/reverse-auth/check-jobs/${encodeURIComponent(id)}`, undefined, '加载 reverse 账号检查进度失败')
    .then(normalizeAdminReverseAuthCheckJobResponse)
}

function normalizeAdminReverseAuthCheckJobResponse(response: AdminReverseAuthCheckJobResponse): AdminReverseAuthCheckJobResponse {
  const { job } = response
  return {
    ...response,
    job: {
      ...job,
      results: Array.isArray(job.results) ? job.results : [],
    },
  }
}

export function uploadAdminReverseAuthAccount(file: File) {
  const body = new FormData()
  body.set('file', file)
  return authJson<{ account: AdminReverseAuthAccount }>('/api/admin/reverse-auth/accounts', {
    method: 'POST',
    body,
  }, '导入 reverse 账号失败')
}

export function importAdminReverseAuthAccessToken(body: { accessToken: string; email?: string; name?: string }) {
  return authJson<{ account: AdminReverseAuthAccount }>('/api/admin/reverse-auth/accounts/access-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, '导入 access_token 失败')
}

export function fetchAdminReverseAuthImportSources() {
  return authJson<{ sources: AdminReverseAuthImportSource[] }>('/api/admin/reverse-auth/sources', undefined, '读取导入来源失败')
}

export function saveAdminReverseAuthImportSources(sources: AdminReverseAuthImportSource[]) {
  return authJson<{ sources: AdminReverseAuthImportSource[] }>('/api/admin/reverse-auth/sources', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources }),
  }, '保存导入来源失败')
}

export function fetchAdminReverseAuthCLIProxyAccounts(sourceId?: string) {
  const query = sourceId?.trim() ? `?sourceId=${encodeURIComponent(sourceId.trim())}` : ''
  return authJson<{ accounts: AdminReverseAuthCLIProxyAccount[] }>(`/api/admin/reverse-auth/cliproxy/accounts${query}`, undefined, '读取 CLIProxyAPI 账号失败')
}

export function importAdminReverseAuthCLIProxyAccounts(names: string[], sourceId?: string) {
  const normalizedSourceId = sourceId?.trim()
  return authJson<AdminReverseAuthImportResponse>('/api/admin/reverse-auth/cliproxy/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizedSourceId ? { sourceId: normalizedSourceId, names } : { names }),
  }, '导入 CLIProxyAPI 账号失败')
}

export function importAdminReverseAuthSub2APIAccounts(body: {
  sourceId?: string
  baseUrl: string
  adminToken?: string
  apiKey?: string
  search?: string
  status?: string
}) {
  return authJson<AdminReverseAuthImportResponse>('/api/admin/reverse-auth/sub2api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, '导入 sub2api 账号失败')
}

export function fetchAdminReverseAuthAccount(name: string) {
  return authJson<AdminReverseAuthAccountRaw>(`/api/admin/reverse-auth/accounts/${encodeURIComponent(name)}`, undefined, '加载 reverse 账号 JSON 失败')
}

export function updateAdminReverseAuthAccount(name: string, rawJson: string) {
  return authJson<{ account: AdminReverseAuthAccount }>(`/api/admin/reverse-auth/accounts/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawJson }),
  }, '保存 reverse 账号失败')
}

export function deleteAdminReverseAuthAccount(name: string) {
  return authJson<{ ok: true }>(`/api/admin/reverse-auth/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' }, '删除 reverse 账号失败')
}

export function bulkDeleteAdminReverseAuthAccounts(names: string[]) {
  return authJson<{ ok: true; deleted: string[]; missing: string[] }>('/api/admin/reverse-auth/accounts/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  }, '批量删除 reverse 账号失败')
}

export async function downloadAdminReverseAuthAccounts(): Promise<void> {
  const res = await authFetch('/api/admin/reverse-auth/accounts/export')
  if (!res.ok) throw new Error(await readErrorMessage(res, '导出 reverse 账号失败'))
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/i)
  const filename = match?.[1] ?? `picpilot-reverse-auth-${new Date().toISOString().slice(0, 10)}.json`
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
