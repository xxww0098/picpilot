import { getUserFacingErrorMessage } from './userFacingText'

export const AUTH_TOKEN_KEY = 'auth_token'
const TOKEN_KEY = AUTH_TOKEN_KEY

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    const padded = payload + '==='.slice((payload.length % 4) || 4)
    return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
  } catch {
    return null
  }
}

function getStoredToken(): string | null {
  if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return null
  return localStorage.getItem(TOKEN_KEY)
}

export function getStoredAuthToken(): string | null {
  return getStoredToken()
}

// Synchronously returns userId for storage namespacing. Returns '' when not authenticated or token expired.
export function getUserIdSync(): string {
  const token = getStoredToken()
  if (!token) return ''
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload.sub !== 'string') return ''
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return ''
  return payload.sub
}

// Appends userId suffix when authenticated; otherwise returns the original key — keeps pre-auth deployments backward-compatible.
export function namespacedStorageKey(base: string): string {
  const uid = getUserIdSync()
  return uid ? `${base}-${uid}` : base
}

export interface AuthUser {
  userId: string
  username: string
  displayName: string
  isAdmin: boolean
  avatarUpdatedAt: number | null
  maxBatchImages: number
  galleryAutoRetryCount: number
  maxConcurrent: number
  maxQueue: number
  publicGalleryCount: number
  publicStorageBytes: number
  publicStorageQuotaBytes: number
}

let cachedAuthUser: AuthUser | null = null

export function getCachedAuthUser(): AuthUser | null {
  return cachedAuthUser
}

export function patchCachedAuthUser(patch: Partial<AuthUser>): AuthUser | null {
  if (!cachedAuthUser) return null
  cachedAuthUser = normalizeAuthUser({ ...cachedAuthUser, ...patch })
  return cachedAuthUser
}

function normalizeAuthUser(data: Partial<AuthUser>): AuthUser {
  return {
    userId: data.userId ?? '',
    username: data.username ?? '',
    displayName: data.displayName || data.username || '',
    isAdmin: !!data.isAdmin,
    avatarUpdatedAt: data.avatarUpdatedAt ?? null,
    maxBatchImages: Number(data.maxBatchImages ?? 10),
    galleryAutoRetryCount: Number(data.galleryAutoRetryCount ?? 1),
    maxConcurrent: Number(data.maxConcurrent ?? 5),
    maxQueue: Number(data.maxQueue ?? 50),
    publicGalleryCount: Number(data.publicGalleryCount ?? 0),
    publicStorageBytes: Number(data.publicStorageBytes ?? 0),
    publicStorageQuotaBytes: Number(data.publicStorageQuotaBytes ?? 0),
  }
}

// null = 401, undefined = auth server not configured (404 / network error)
export async function fetchCurrentUser(): Promise<AuthUser | null | undefined> {
  const token = getStoredToken()
  try {
    const res = await fetch('/api/auth/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 404) return undefined
    if (!res.ok) {
      cachedAuthUser = null
      return null
    }
    const data = (await res.json()) as Partial<AuthUser>
    const user = normalizeAuthUser(data)
    cachedAuthUser = user
    return user
  } catch {
    return undefined
  }
}

type AuthResponse = { token: string } & AuthUser

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(getUserFacingErrorMessage(data.error ?? '登录失败', '登录失败', res.status))
  }
  const data = (await res.json()) as AuthResponse
  localStorage.setItem(TOKEN_KEY, data.token)
  cachedAuthUser = normalizeAuthUser(data)
  return cachedAuthUser
}

export async function register(invite: string, username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite, username, password }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(getUserFacingErrorMessage(data.error ?? '注册失败', '注册失败', res.status))
  }
  const data = (await res.json()) as AuthResponse
  localStorage.setItem(TOKEN_KEY, data.token)
  cachedAuthUser = normalizeAuthUser(data)
  return cachedAuthUser
}

export async function updateDisplayName(displayName: string): Promise<AuthUser> {
  const res = await authFetch('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(getUserFacingErrorMessage(data.error ?? '更新显示名失败', '更新显示名失败', res.status))
  }
  cachedAuthUser = normalizeAuthUser((await res.json()) as Partial<AuthUser>)
  return cachedAuthUser
}

export async function uploadAvatar(imageBase64: string): Promise<{ avatarUpdatedAt: number }> {
  const res = await authFetch('/api/auth/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: imageBase64 }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(getUserFacingErrorMessage(data.error ?? '上传头像失败', '上传头像失败', res.status))
  }
  return (await res.json()) as { avatarUpdatedAt: number }
}

export async function deleteAvatar(): Promise<void> {
  const res = await authFetch('/api/auth/avatar', { method: 'DELETE' })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(getUserFacingErrorMessage(data.error ?? '删除头像失败', '删除头像失败', res.status))
  }
}

export async function fetchAvatarBlob(userId: string): Promise<Blob | null> {
  const res = await authFetch(`/api/avatars/${encodeURIComponent(userId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('加载头像失败')
  return res.blob()
}

// 滑动续期：用当前（仍有效的）令牌换一枚新的短时令牌。
// 'refreshed' 已更新 localStorage；'invalid' 表示会话已失效（过期/撤销/达上限）应登出；
// 'skip' 表示无令牌或网络抖动，保持现状下次再试。
export async function refreshAuthToken(): Promise<'refreshed' | 'invalid' | 'skip'> {
  const token = getStoredToken()
  if (!token) return 'skip'
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401 || res.status === 403) return 'invalid'
    if (!res.ok) return 'skip'
    const data = (await res.json()) as { token?: string }
    if (!data.token) return 'skip'
    localStorage.setItem(TOKEN_KEY, data.token)
    return 'refreshed'
  } catch {
    return 'skip'
  }
}

export function logout(): void {
  cachedAuthUser = null
  if (typeof localStorage?.removeItem !== 'function') return
  localStorage.removeItem(TOKEN_KEY)
}

// Fetch wrapper that auto-attaches the JWT and treats 401 as logout.
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getStoredToken()
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) {
    logout()
    window.location.reload()
  }
  return res
}
