import { useCallback, useEffect, useState } from 'react'
import { authFetch } from '../../lib/auth'

interface UserRow {
  id: string
  username: string
  is_admin: number
  created_at: number
  total_requests: number | null
  success_count: number | null
  failure_count: number | null
  last_request_at: number | null
  total_duration_ms: number | null
  total_output_bytes: number | null
}

function formatRelative(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  return new Date(ts).toLocaleDateString()
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '0'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(1)}${units[i]}`
}

function formatDuration(ms: number | null): string {
  if (!ms) return '0'
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}min`
  return `${(min / 60).toFixed(1)}h`
}

export default function UserList() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch('/api/admin/users')
      if (!res.ok) throw new Error('加载失败')
      const data = (await res.json()) as { users: UserRow[] }
      setUsers(data.users)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function patchUser(id: string, body: { isAdmin?: boolean; password?: string }) {
    setBusyId(id)
    try {
      const res = await authFetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '操作失败')
      }
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  async function deleteUser(id: string, username: string) {
    if (!confirm(`确定删除用户 ${username}？\n会同时删除其公开图与遥测数据。`)) return
    setBusyId(id)
    try {
      const res = await authFetch(`/api/admin/users/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '删除失败')
      }
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  async function resetPassword(id: string, username: string) {
    const pwd = prompt(`为 ${username} 设置新密码（至少 6 位）：`)
    if (!pwd) return
    if (pwd.length < 6) { alert('密码至少 6 位'); return }
    await patchUser(id, { password: pwd })
    alert('密码已更新')
  }

  if (loading) return <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>
  if (error) return <p className="text-sm text-red-500">{error}</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[hsl(var(--border))] text-left text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            <th className="py-2 pr-3">用户名</th>
            <th className="py-2 pr-3">角色</th>
            <th className="py-2 pr-3 text-right">成功</th>
            <th className="py-2 pr-3 text-right">失败</th>
            <th className="py-2 pr-3 text-right">总请求</th>
            <th className="py-2 pr-3 text-right">累计耗时</th>
            <th className="py-2 pr-3 text-right">累计输出</th>
            <th className="py-2 pr-3">最后请求</th>
            <th className="py-2 pr-3">操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-[hsl(var(--border))] last:border-0">
              <td className="py-2.5 pr-3 text-[hsl(var(--foreground))]">{u.username}</td>
              <td className="py-2.5 pr-3">
                {u.is_admin ? (
                  <span className="rounded bg-[hsl(var(--primary))]/10 px-1.5 py-0.5 text-xs text-[hsl(var(--primary))]">admin</span>
                ) : (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">user</span>
                )}
              </td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-green-600 dark:text-green-400">{u.success_count ?? 0}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-red-500">{u.failure_count ?? 0}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-[hsl(var(--foreground))]">{u.total_requests ?? 0}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{formatDuration(u.total_duration_ms)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{formatBytes(u.total_output_bytes)}</td>
              <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{formatRelative(u.last_request_at)}</td>
              <td className="py-2.5 pr-3">
                <div className="flex gap-2">
                  <button
                    disabled={busyId === u.id}
                    onClick={() => void patchUser(u.id, { isAdmin: u.is_admin !== 1 })}
                    className="text-xs text-[hsl(var(--primary))] hover:underline disabled:opacity-50"
                  >
                    {u.is_admin ? '取消管理' : '设为管理'}
                  </button>
                  <button
                    disabled={busyId === u.id}
                    onClick={() => void resetPassword(u.id, u.username)}
                    className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                  >
                    重置密码
                  </button>
                  <button
                    disabled={busyId === u.id}
                    onClick={() => void deleteUser(u.id, u.username)}
                    className="text-xs text-red-500 hover:underline disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
