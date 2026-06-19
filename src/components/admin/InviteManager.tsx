import { useState } from 'react'
import {
  createAdminInvite,
  deleteAdminInvite,
  fetchAdminInvites,
  type AdminInviteRedemption,
  type AdminInviteRow,
} from '../../lib/server/adminApi'
import { copyTextToClipboard } from '../../lib/ui/clipboard'
import { openDestructiveConfirm, showAppToast } from '../../lib/ui/dialog'
import { formatOptionalExpiry, formatRelative } from '../../lib/ui/format'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import Button from '../ui/Button'
import Input from '../ui/Input'
import QueryState from './QueryState'

function buildInviteUrl(code: string): string {
  return `${window.location.origin}/register?invite=${code}`
}

export default function InviteManager() {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchAdminInvites(), [])
  const [creating, setCreating] = useState(false)
  const [newCount, setNewCount] = useState(1)
  const [newMaxUses, setNewMaxUses] = useState(1)
  const [newNote, setNewNote] = useState('')
  const [newExpiresDays, setNewExpiresDays] = useState<number | ''>('')
  const [lastCreated, setLastCreated] = useState<string[] | null>(null)
  const invites = data?.invites ?? []

  async function createInvite(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      const body: Record<string, unknown> = { maxUses: newMaxUses, count: newCount }
      if (newNote.trim()) body.note = newNote.trim()
      if (newExpiresDays !== '' && newExpiresDays > 0) {
        body.expiresAt = Date.now() + newExpiresDays * 24 * 60 * 60 * 1000
      }
      const result = await createAdminInvite(body)
      setLastCreated(result.codes ?? [result.code])
      setNewNote('')
      await reload()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '生成邀请码失败'), 'error')
    } finally {
      setCreating(false)
    }
  }

  function revokeInvite(code: string) {
    openDestructiveConfirm({
      title: '吊销邀请码',
      message: `确定吊销邀请码「${code}」吗？\n吊销后，未使用该邀请码的人将无法注册。`,
      confirmText: '确认吊销',
      onConfirm: async () => {
        try {
          await deleteAdminInvite(code)
          await reload()
        } catch (e) {
          showAppToast(getUserFacingErrorMessage(e, '吊销邀请码失败'), 'error')
        }
      },
    })
  }

  async function copyInviteUrl(code: string) {
    try {
      await copyTextToClipboard(buildInviteUrl(code))
      showAppToast('邀请链接已复制', 'success')
    } catch {
      showAppToast('复制失败：请检查浏览器是否允许访问剪贴板。', 'error')
    }
  }

  async function copyAllUrls(codes: string[]) {
    try {
      await copyTextToClipboard(codes.map(buildInviteUrl).join('\n'))
      showAppToast(`已复制 ${codes.length} 条邀请链接`, 'success')
    } catch {
      showAppToast('复制失败：请检查浏览器是否允许访问剪贴板。', 'error')
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => void createInvite(e)}
        className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20"
      >
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[hsl(var(--foreground))]">
          创建注册邀请码
        </h3>
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">生成数量</label>
            <Input
              className="mt-1"
              type="number"
              min={1}
              max={50}
              value={newCount}
              onChange={(e) => setNewCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
            />
          </div>
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">每码可注册人数</label>
            <Input
              className="mt-1"
              type="number"
              min={1}
              max={1000}
              value={newMaxUses}
              onChange={(e) => setNewMaxUses(Math.max(1, Number(e.target.value)))}
            />
          </div>
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">有效期（天，留空为永久）</label>
            <Input
              className="mt-1"
              type="number"
              min={1}
              value={newExpiresDays}
              onChange={(e) => setNewExpiresDays(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">备注（可选）</label>
            <Input
              className="mt-1"
              type="text"
              placeholder="例如：给设计组"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={creating}>
            {creating ? '创建中…' : newCount > 1 ? `批量生成 ${newCount} 个` : '创建邀请码'}
          </Button>
        </div>

        {lastCreated && lastCreated.length > 0 && (
          <div className="mt-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.35)] p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[hsl(var(--muted-foreground))]">
              <span>本次生成 {lastCreated.length} 条邀请链接</span>
              <Button type="button" variant="link" size="xs" onClick={() => void copyAllUrls(lastCreated)}>
                复制全部
              </Button>
            </div>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs font-mono">
              {lastCreated.map((c) => (
                <li key={c} className="flex items-center justify-between gap-2">
                  <span className="truncate text-[hsl(var(--foreground))]">{buildInviteUrl(c)}</span>
                  <Button type="button" variant="link" size="xs" className="shrink-0" onClick={() => void copyInviteUrl(c)}>
                    复制
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>

      <QueryState loading={loading} error={error} empty={invites.length === 0} emptyMessage="还没有邀请码">
        <InviteTable invites={invites} onCopy={copyInviteUrl} onRevoke={revokeInvite} />
      </QueryState>
    </div>
  )
}

function InviteTable({
  invites,
  onCopy,
  onRevoke,
}: {
  invites: AdminInviteRow[]
  onCopy: (code: string) => void | Promise<void>
  onRevoke: (code: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(code: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <table className="w-full text-sm">
        <thead className="bg-[hsl(var(--muted)/0.4)]">
          <tr className="border-b border-[hsl(var(--border))] text-left text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            <th className="py-2.5 pr-3 pl-4 w-6"></th>
            <th className="py-2.5 pr-3">邀请码</th>
            <th className="py-2.5 pr-3">备注</th>
            <th className="py-2.5 pr-3 text-right">已注册 / 可注册</th>
            <th className="py-2.5 pr-3">有效期</th>
            <th className="py-2.5 pr-3">创建人</th>
            <th className="py-2.5 pr-3 pr-4">操作</th>
          </tr>
        </thead>
      <tbody>
        {invites.map((inv) => {
          const expired = inv.expires_at != null && inv.expires_at < Date.now()
          const exhausted = inv.used_count >= inv.max_uses
          const dead = expired || exhausted
          const isOpen = expanded.has(inv.code)
          const hasRedemptions = inv.redemptions.length > 0
          return (
            <RowFragment
              key={inv.code}
              inv={inv}
              dead={dead}
              isOpen={isOpen}
              hasRedemptions={hasRedemptions}
              onToggle={() => toggle(inv.code)}
              onCopy={() => void onCopy(inv.code)}
              onRevoke={() => onRevoke(inv.code)}
            />
          )
        })}
      </tbody>
    </table>
    </div>
  )
}

function RowFragment({
  inv,
  dead,
  isOpen,
  hasRedemptions,
  onToggle,
  onCopy,
  onRevoke,
}: {
  inv: AdminInviteRow
  dead: boolean
  isOpen: boolean
  hasRedemptions: boolean
  onToggle: () => void
  onCopy: () => void
  onRevoke: () => void
}) {
  return (
    <>
      <tr className="border-b border-[hsl(var(--border))] last:border-0 transition-colors hover:bg-[hsl(var(--muted)/0.35)]">
        <td className="py-2.5 pr-3 pl-4">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onToggle}
            disabled={!hasRedemptions}
            aria-label={isOpen ? '收起兑换记录' : '展开兑换记录'}
            aria-expanded={isOpen}
            className="rounded text-[hsl(var(--muted-foreground))] disabled:opacity-30"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`}>
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </td>
        <td className="py-2.5 pr-3 font-mono text-[hsl(var(--foreground))]">
          <span className={dead ? 'line-through text-[hsl(var(--muted-foreground))]' : ''}>{inv.code}</span>
        </td>
        <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{inv.note ?? '—'}</td>
        <td className="py-2.5 pr-3 text-right tabular-nums">{inv.used_count} / {inv.max_uses}</td>
        <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{formatOptionalExpiry(inv.expires_at)}</td>
        <td className="py-2.5 pr-3 text-[hsl(var(--muted-foreground))]">{inv.creator_username ?? '—'}</td>
        <td className="py-2.5 pr-3 pr-4">
          <div className="flex gap-2">
            <Button type="button" variant="link" size="xs" onClick={onCopy}>复制链接</Button>
            <Button type="button" variant="link" size="xs" className="text-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))]" onClick={onRevoke}>吊销</Button>
          </div>
        </td>
      </tr>
      {isOpen && hasRedemptions && (
        <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.25)]">
          <td></td>
          <td colSpan={6} className="py-2 pr-3">
            <RedemptionList items={inv.redemptions} />
          </td>
        </tr>
      )}
    </>
  )
}

function RedemptionList({ items }: { items: AdminInviteRedemption[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {items.map((r) => (
        <li key={`${r.user_id}-${r.redeemed_at}`} className="flex items-center gap-3 text-[hsl(var(--muted-foreground))]">
          <span className="font-medium text-[hsl(var(--foreground))]">{r.username ?? '（已删除用户）'}</span>
          <span>{new Date(r.redeemed_at).toLocaleString()}</span>
          <span className="text-[hsl(var(--muted-foreground))]/70">·</span>
          <span title={`兑换于 ${new Date(r.redeemed_at).toISOString()}`}>{formatRelative(r.redeemed_at)}</span>
        </li>
      ))}
    </ul>
  )
}
