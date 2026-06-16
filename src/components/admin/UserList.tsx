import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  deleteAdminUser,
  fetchAdminUsers,
  patchAdminUser,
  type AdminUserRow,
} from '../../lib/server/adminApi'
import { openConfirmDialog, openDestructiveConfirm, openPromptDialog, showAppToast } from '../../lib/ui/dialog'
import { formatRelative } from '../../lib/ui/format'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import { useAuth } from '../../contexts/AuthProvider'
import Avatar from '../ui/Avatar'
import QueryState from './QueryState'

export default function UserList() {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchAdminUsers(), [])
  const { user: currentUser, refresh } = useAuth()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const users = data?.users ?? []

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.username.toLowerCase().includes(q))
  }, [users, query])

  async function patchUser(id: string, body: { isAdmin?: boolean; password?: string; disabled?: boolean }) {
    setBusyId(id)
    try {
      await patchAdminUser(id, body)
      await reload()
      await refresh()
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '操作失败'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  function deleteUser(id: string, username: string) {
    openDestructiveConfirm({
      title: '删除用户',
      message: `确定删除用户「${username}」吗？\n该用户的公开图片和请求记录也会一起删除，此操作不可恢复。`,
      onConfirm: async () => {
        setBusyId(id)
        try {
          await deleteAdminUser(id)
          await reload()
        } catch (e) {
          showAppToast(getUserFacingErrorMessage(e, '删除失败'), 'error')
        } finally {
          setBusyId(null)
        }
      },
    })
  }

  function toggleDisabled(id: string, username: string, currentlyDisabled: boolean) {
    if (currentlyDisabled) {
      void patchUser(id, { disabled: false }).then(() => showAppToast(`已启用「${username}」。`, 'success'))
      return
    }
    openConfirmDialog({
      title: '禁用账号',
      message: `禁用后「${username}」将无法登录和出图，已登录的会话也会立即失效。可随时重新启用。`,
      tone: 'warning',
      confirmText: '禁用',
      onConfirm: async () => {
        await patchUser(id, { disabled: true })
        showAppToast(`已禁用「${username}」。`, 'success')
      },
    })
  }

  function resetPassword(id: string, username: string) {
    openPromptDialog({
      title: '重置密码',
      message: `为「${username}」设置新密码（至少 6 位）`,
      inputType: 'password',
      placeholder: '新密码',
      validate: (pwd) => (pwd.length < 6 ? '新密码至少需要 6 位。' : null),
      onConfirm: async (pwd) => {
        await patchUser(id, { password: pwd })
        showAppToast('密码已更新。', 'success')
      },
    })
  }

  if (loading) return <UserListSkeleton />

  return (
    <QueryState loading={false} error={error} empty={users.length === 0} emptyMessage="暂无用户">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            共 <span className="font-medium tabular-nums text-[hsl(var(--foreground))]">{users.length}</span> 位用户
          </p>
          <label className="relative block w-full sm:max-w-xs">
            <span className="sr-only">搜索用户</span>
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M20 20l-3-3" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索用户名…"
              className="w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.35)] py-2.5 pl-9 pr-3 text-sm text-[hsl(var(--foreground))] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] focus:bg-[hsl(var(--background))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.15)]"
            />
          </label>
        </div>

        {filteredUsers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[hsl(var(--border))] px-4 py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
            {query.trim() ? '没有匹配的用户' : '暂无用户'}
          </p>
        ) : (
          <div className="divide-y divide-[hsl(var(--border))] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-sm shadow-black/[0.03] dark:shadow-black/20">
            {filteredUsers.map((user) => (
              <UserCard
                key={user.id}
                user={user}
                busy={busyId === user.id}
                isSelf={user.id === currentUser?.userId}
                onToggleAdmin={() => void patchUser(user.id, { isAdmin: user.is_admin !== 1 })}
                onToggleDisabled={() => toggleDisabled(user.id, user.username, user.disabled === 1)}
                onResetPassword={() => resetPassword(user.id, user.username)}
                onDelete={() => deleteUser(user.id, user.username)}
              />
            ))}
          </div>
        )}
      </div>
    </QueryState>
  )
}

function UserListSkeleton() {
  return (
    <div className="divide-y divide-[hsl(var(--border))] overflow-hidden rounded-xl border border-[hsl(var(--border))]" aria-busy aria-label="加载用户列表">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="animate-pulse flex items-center gap-3 px-3 py-2.5">
          <div className="h-9 w-9 shrink-0 rounded-full bg-[hsl(var(--muted))]" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-28 rounded bg-[hsl(var(--muted))]" />
            <div className="h-2.5 w-40 rounded bg-[hsl(var(--muted))]" />
          </div>
          <div className="hidden gap-5 sm:flex">
            {Array.from({ length: 3 }, (_, j) => (
              <div key={j} className="h-7 w-8 rounded bg-[hsl(var(--muted))]" />
            ))}
          </div>
          <div className="h-7 w-7 rounded-lg bg-[hsl(var(--muted))]" />
        </div>
      ))}
    </div>
  )
}

function UserStat({ value, label, tone }: { value: number; label: string; tone?: 'success' | 'danger' }) {
  const color =
    tone === 'success'
      ? 'text-green-600 dark:text-green-400'
      : tone === 'danger'
        ? value > 0 ? 'text-red-600 dark:text-red-400' : 'text-[hsl(var(--muted-foreground))]'
        : 'text-[hsl(var(--foreground))]'
  return (
    <div className="w-10 text-center leading-tight">
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">{label}</div>
    </div>
  )
}

function UserCard({
  user,
  busy,
  isSelf,
  onToggleAdmin,
  onToggleDisabled,
  onResetPassword,
  onDelete,
}: {
  user: AdminUserRow
  busy: boolean
  isSelf: boolean
  onToggleAdmin: () => void
  onToggleDisabled: () => void
  onResetPassword: () => void
  onDelete: () => void
}) {
  const successCount = user.success_count ?? 0
  const failureCount = user.failure_count ?? 0
  const totalRequests = user.total_requests ?? 0
  const isDisabled = user.disabled === 1

  const stats = (
    <>
      <UserStat value={totalRequests} label="总请求" />
      <UserStat value={successCount} label="成功" tone="success" />
      <UserStat value={failureCount} label="失败" tone="danger" />
    </>
  )

  const menu = (
    <UserActionsMenu
      busy={busy}
      isAdmin={!!user.is_admin}
      isSelf={isSelf}
      isDisabled={isDisabled}
      onToggleAdmin={onToggleAdmin}
      onToggleDisabled={onToggleDisabled}
      onResetPassword={onResetPassword}
      onDelete={onDelete}
    />
  )

  return (
    <article className="group flex flex-col gap-2 px-3 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-[hsl(var(--muted)/0.35)] sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar
          userId={user.id}
          username={user.username}
          avatarUpdatedAt={user.avatar_updated_at}
          size={36}
          className={`shrink-0 ${user.is_admin ? 'ring-2 ring-[hsl(var(--primary)/0.4)]' : ''} ${isDisabled ? 'opacity-40 grayscale' : ''}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={`truncate text-sm font-semibold ${isDisabled ? 'text-[hsl(var(--muted-foreground))] line-through' : 'text-[hsl(var(--foreground))]'}`}>{user.username}</h3>
            {user.is_admin ? (
              <span className="shrink-0 rounded-full bg-[hsl(var(--primary)/0.12)] px-1.5 py-0.5 text-[0.65rem] font-medium text-[hsl(var(--primary))]">
                管理员
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[0.65rem] font-medium text-[hsl(var(--muted-foreground))]">
                成员
              </span>
            )}
            {isDisabled && (
              <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-red-600 dark:text-red-400">
                已禁用
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-[hsl(var(--muted-foreground))]">
            登录 {formatRelative(user.last_login_at)}
            <span className="mx-1.5 text-[hsl(var(--border))]">·</span>
            请求 {formatRelative(user.last_request_at)}
          </p>
        </div>
        {/* 移动端：操作菜单贴右，统计另起一行 */}
        <div className="shrink-0 sm:hidden">{menu}</div>
      </div>

      {/* 统计：移动端整行靠左，桌面端贴右内联 */}
      <div className="flex shrink-0 items-center gap-5 pl-12 sm:pl-0">{stats}</div>

      <div className="hidden shrink-0 sm:block">{menu}</div>
    </article>
  )
}

function UserActionsMenu({
  busy,
  isAdmin,
  isSelf,
  isDisabled,
  onToggleAdmin,
  onToggleDisabled,
  onResetPassword,
  onDelete,
}: {
  busy: boolean
  isAdmin: boolean
  isSelf: boolean
  isDisabled: boolean
  onToggleAdmin: () => void
  onToggleDisabled: () => void
  onResetPassword: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  function run(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="用户操作"
        className="rounded-lg p-2 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-[10.5rem] overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] py-1 shadow-lg shadow-black/10 ring-1 ring-black/5 dark:shadow-black/40 dark:ring-white/10"
        >
          {!(isSelf && isAdmin) && (
            <MenuButton onClick={() => run(onToggleAdmin)}>{isAdmin ? '取消管理员' : '设为管理员'}</MenuButton>
          )}
          <MenuButton onClick={() => run(onResetPassword)}>重置密码</MenuButton>
          {!isSelf && (
            <MenuButton onClick={() => run(onToggleDisabled)}>{isDisabled ? '启用账号' : '禁用账号'}</MenuButton>
          )}
          {!isSelf && (
            <>
              <div className="my-1 h-px bg-[hsl(var(--border))]" role="separator" />
              <MenuButton onClick={() => run(onDelete)} destructive>
                删除用户
              </MenuButton>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function MenuButton({
  children,
  onClick,
  destructive = false,
}: {
  children: ReactNode
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full px-3 py-2 text-left text-sm transition-colors hover:bg-[hsl(var(--muted)/0.5)] ${
        destructive ? 'text-red-600 dark:text-red-400' : 'text-[hsl(var(--foreground))]'
      }`}
    >
      {children}
    </button>
  )
}
