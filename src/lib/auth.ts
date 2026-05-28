const TOKEN_KEY = 'auth_token'

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

// Synchronously returns userId for storage namespacing. Returns '' when not authenticated or token expired.
export function getUserIdSync(): string {
  const token = localStorage.getItem(TOKEN_KEY)
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
  isAdmin: boolean
}

// null = 401, undefined = auth server not configured (404 / network error)
export async function fetchCurrentUser(): Promise<AuthUser | null | undefined> {
  const token = localStorage.getItem(TOKEN_KEY)
  try {
    const res = await fetch('/api/auth/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 404) return undefined
    if (!res.ok) return null
    return (await res.json()) as AuthUser
  } catch {
    return undefined
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? '登录失败')
  }
  const data = (await res.json()) as { token: string; userId: string; username: string; isAdmin: boolean }
  localStorage.setItem(TOKEN_KEY, data.token)
  return { userId: data.userId, username: data.username, isAdmin: data.isAdmin }
}

export async function register(invite: string, username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite, username, password }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? '注册失败')
  }
  const data = (await res.json()) as { token: string; userId: string; username: string; isAdmin: boolean }
  localStorage.setItem(TOKEN_KEY, data.token)
  return { userId: data.userId, username: data.username, isAdmin: data.isAdmin }
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// Fetch wrapper that auto-attaches the JWT and treats 401 as logout.
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY)
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) {
    logout()
    window.location.reload()
  }
  return res
}
