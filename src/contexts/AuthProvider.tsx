import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchCurrentUser, logout, patchCachedAuthUser, refreshAuthToken, type AuthUser } from '../lib/auth'

// 访问令牌有效期较短（默认 2h），在过期前定时续期，确保活跃用户不被中途登出。
// 远小于令牌寿命即可保证总在有效窗口内换发；同时在窗口重新获得焦点时立即续一次。
const TOKEN_REFRESH_INTERVAL_MS = 25 * 60 * 1000

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated' | 'disabled'

interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  authEnabled: boolean
  refresh: () => Promise<void>
  /** 本地合并更新当前用户的部分字段（如配额 / 张数），免去一次 /api/me 往返 */
  patchUser: (patch: Partial<AuthUser>) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function resolveAuthState(result: AuthUser | null | undefined): Pick<AuthContextValue, 'status' | 'user' | 'authEnabled'> {
  if (result === undefined) {
    return { status: 'disabled', user: null, authEnabled: false }
  }
  if (result === null) {
    return { status: 'unauthenticated', user: null, authEnabled: true }
  }
  return { status: 'authenticated', user: result, authEnabled: true }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authEnabled, setAuthEnabled] = useState(false)

  const refresh = useCallback(async () => {
    const next = resolveAuthState(await fetchCurrentUser())
    setStatus(next.status)
    setUser(next.user)
    setAuthEnabled(next.authEnabled)
  }, [])

  const patchUser = useCallback((patch: Partial<AuthUser>) => {
    patchCachedAuthUser(patch)
    setUser((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 已登录时：定时 + 重新聚焦时静默续期短时令牌。续期失败（会话失效/撤销/达上限）则登出。
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    const tick = async () => {
      if (cancelled || document.visibilityState === 'hidden') return
      const result = await refreshAuthToken()
      if (cancelled) return
      if (result === 'invalid') {
        logout()
        void refresh()
      }
    }
    const interval = setInterval(() => void tick(), TOKEN_REFRESH_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [status, refresh])

  const value = useMemo(
    () => ({ status, user, authEnabled, refresh, patchUser }),
    [status, user, authEnabled, refresh, patchUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
