import { useState, useRef, useEffect } from 'react'
import { login } from '../lib/auth'

interface Props {
  onSuccess: () => void
  onSwitchToRegister?: () => void
}

export default function LoginModal({ onSuccess, onSwitchToRegister }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    usernameRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username || !password || loading) return
    setError('')
    setLoading(true)
    try {
      await login(username, password)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-white p-8 shadow-xl dark:bg-[hsl(240_10%_10%)]">
        <h1 className="mb-6 text-center text-xl font-semibold text-[hsl(var(--foreground))]">登录</h1>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <input
            ref={usernameRef}
            type="text"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="w-full rounded-lg border border-[hsl(var(--border))] bg-transparent px-4 py-2.5 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] focus:ring-1 focus:ring-[hsl(var(--primary))]"
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-lg border border-[hsl(var(--border))] bg-transparent px-4 py-2.5 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] focus:ring-1 focus:ring-[hsl(var(--primary))]"
          />
          {error && (
            <p className="text-center text-sm text-red-500">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="mt-1 w-full rounded-lg bg-[hsl(var(--primary))] py-2.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? '登录中…' : '登录'}
          </button>
          {onSwitchToRegister && (
            <button
              type="button"
              onClick={onSwitchToRegister}
              className="text-center text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
            >
              有邀请码？前往注册
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
