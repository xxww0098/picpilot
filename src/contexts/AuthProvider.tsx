import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchCurrentUser, type AuthUser } from '../lib/auth'

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated' | 'disabled'

interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  authEnabled: boolean
  refresh: () => Promise<void>
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

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(
    () => ({ status, user, authEnabled, refresh }),
    [status, user, authEnabled, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
