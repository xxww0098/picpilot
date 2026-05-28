import { useState, useRef, useEffect } from 'react'
import { register } from '../lib/auth'

interface Props {
  initialInvite?: string
  onSuccess: () => void
  onSwitchToLogin: () => void
}

export default function RegisterModal({ initialInvite, onSuccess, onSwitchToLogin }: Props) {
  const [invite, setInvite] = useState(initialInvite ?? '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!invite || !username || !password || loading) return
    setError('')
    setLoading(true)
    try {
      await register(invite.trim(), username.trim(), password)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败')
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'w-full rounded-lg border border-[hsl(var(--border))] bg-transparent px-4 py-2.5 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] focus:ring-1 focus:ring-[hsl(var(--primary))]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-white p-8 shadow-xl dark:bg-[hsl(240_10%_10%)]">
        <h1 className="mb-6 text-center text-xl font-semibold text-[hsl(var(--foreground))]">使用邀请码注册</h1>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <input
            ref={firstFieldRef}
            type="text"
            placeholder="邀请码"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            className={inputClass}
            autoComplete="off"
          />
          <input
            type="text"
            placeholder="用户名 (2-32 字符)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className={inputClass}
          />
          <input
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className={inputClass}
          />
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading || !invite || !username || !password}
            className="mt-1 w-full rounded-lg bg-[hsl(var(--primary))] py-2.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? '注册中…' : '注册'}
          </button>
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="text-center text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
          >
            已有账号？返回登录
          </button>
        </form>
      </div>
    </div>
  )
}
