import { useCallback, useEffect, useState } from 'react'
import { authFetch } from '../../lib/auth'
import { copyTextToClipboard } from '../../lib/clipboard'

interface InviteRow {
  code: string
  created_by: string
  creator_username: string | null
  created_at: number
  expires_at: number | null
  max_uses: number
  used_count: number
  note: string | null
}

function formatTs(ts: number | null): string {
  if (!ts) return '永久'
  return new Date(ts).toLocaleString()
}

export default function InviteManager() {
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newMaxUses, setNewMaxUses] = useState(1)
  const [newNote, setNewNote] = useState('')
  const [newExpiresDays, setNewExpiresDays] = useState<number | ''>('')
  const [lastCreated, setLastCreated] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch('/api/admin/invites')
      if (!res.ok) throw new Error('加载失败')
      const data = (await res.json()) as { invites: InviteRow[] }
      setInvites(data.invites)
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

  async function createInvite(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      const body: Record<string, unknown> = { maxUses: newMaxUses }
      if (newNote.trim()) body.note = newNote.trim()
      if (newExpiresDays !== '' && newExpiresDays > 0) {
        body.expiresAt = Date.now() + newExpiresDays * 24 * 60 * 60 * 1000
      }
      const res = await authFetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '生成失败')
      }
      const data = (await res.json()) as { code: string }
      setLastCreated(data.code)
      setNewNote('')
      await load()
    } catch (err) {
      alert(err instanceof Error ? err.message : '生成失败')
    } finally {
      setCreating(false)
    }
  }

  async function revokeInvite(code: string) {
    if (!confirm(`确定吊销邀请码 ${code}？`)) return
    try {
      const res = await authFetch(`/api/admin/invites/${code}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('吊销失败')
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '吊销失败')
    }
  }

  function buildInviteUrl(code: string): string {
    return `${window.location.origin}/register?invite=${code}`
  }

  async function copyInviteUrl(code: string) {
    try {
      await copyTextToClipboard(buildInviteUrl(code))
      alert('邀请链接已复制')
    } catch {
      alert('复制失败')
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={(e) => void createInvite(e)} className="rounded-lg border border-[hsl(var(--border))] p-4">
        <h3 className="mb-3 text-sm font-medium text-[hsl(var(--foreground))]">生成新邀请码</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">最大使用次数</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={newMaxUses}
              onChange={(e) => setNewMaxUses(Math.max(1, Number(e.target.value)))}
              className="mt-1 w-full rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          </div>
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">有效期（天，留空 = 永久）</label>
            <input
              type="number"
              min={1}
              value={newExpiresDays}
              onChange={(e) => setNewExpiresDays(e.target.value === '' ? '' : Number(e.target.value))}
              className="mt-1 w-full rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          </div>
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">备注（可选）</label>
            <input
              type="text"
              placeholder="给张三"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              className="mt-1 w-full rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            {creating ? '生成中…' : '生成'}
          </button>
          {lastCreated && (
            <span className="text-sm text-[hsl(var(--muted-foreground))]">
              已生成 <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[hsl(var(--foreground))]">{lastCreated}</code>
              <button
                type="button"
                onClick={() => void copyInviteUrl(lastCreated)}
                className="ml-2 text-[hsl(var(--primary))] hover:underline"
              >
                复制链接
              </button>
            </span>
          )}
        </div>
      </form>

      <div>
        {loading && <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {!loading && !error && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] text-left text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                <th className="py-2 pr-3">代码</th>
                <th className="py-2 pr-3">备注</th>
                <th className="py-2 pr-3 text-right">已用 / 上限</th>
                <th className="py-2 pr-3">过期</th>
                <th className="py-2 pr-3">创建人</th>
                <th className="py-2 pr-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {invites.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">无邀请码</td></tr>
              )}
              {invites.map((inv) => {
                const expired = inv.expires_at != null && inv.expires_at < Date.now()
                const exhausted = inv.used_count >= inv.max_uses
                const dead = expired || exhausted
                return (
                  <tr key={inv.code} className="border-b border-[hsl(var(--border))] last:border-0">
                    <td className="py-2.5 pr-3 font-mono text-[hsl(var(--foreground))]">
                      <span className={dead ? 'line-through text-[hsl(var(--muted-foreground))]' : ''}>{inv.code}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{inv.note ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{inv.used_count} / {inv.max_uses}</td>
                    <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{formatTs(inv.expires_at)}</td>
                    <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{inv.creator_username ?? '—'}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => void copyInviteUrl(inv.code)}
                          className="text-xs text-[hsl(var(--primary))] hover:underline"
                        >
                          复制链接
                        </button>
                        <button
                          onClick={() => void revokeInvite(inv.code)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          吊销
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
