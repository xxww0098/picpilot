import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAsyncQuery } from '../hooks/useAsyncQuery'
import {
  fetchNotifications,
  markNotificationsRead,
  type NotificationItem,
} from '../lib/server/notificationApi'
import { formatRelative } from '../lib/ui/format'
import { showAppToast } from '../lib/ui/dialog'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import { parseGalleryRevokedMeta } from '../lib/shared/schemas'
import PanelShell from './PanelShell'
import { BellIcon } from './icons'

interface Props {
  open: boolean
  onClose: () => void
  onUnreadChange?: (unread: number) => void
}

function getReason(item: NotificationItem): string | null {
  const meta = parseGalleryRevokedMeta(item.metadata)
  if (!meta) return null
  return typeof meta.reason === 'string' && meta.reason.trim() ? meta.reason : null
}

function getActorName(item: NotificationItem): string | null {
  const meta = parseGalleryRevokedMeta(item.metadata)
  if (!meta) return null
  return meta.actor_display_name || meta.actor_username || null
}

export default function NotificationsPanel({ open, onClose, onUnreadChange }: Props) {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchNotifications(50, 0), [], open)
  const [busy, setBusy] = useState(false)

  const items = useMemo(() => data?.items ?? [], [data])
  const unread = data?.unread ?? 0

  useEffect(() => {
    if (data) onUnreadChange?.(data.unread)
  }, [data, onUnreadChange])

  const markAllRead = useCallback(async () => {
    if (busy || unread === 0) return
    setBusy(true)
    try {
      await markNotificationsRead()
      await reload()
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '更新通知状态失败'), 'error')
    } finally {
      setBusy(false)
    }
  }, [busy, unread, reload])

  // 打开面板时若有未读，自动标已读（点开即视为看过）
  useEffect(() => {
    if (!open || !data || data.unread === 0) return
    void markAllRead()
    // 只在面板打开 + 第一次拿到带未读的数据时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data?.unread === 0 ? null : data?.items.length])

  return (
    <PanelShell open={open} onClose={onClose} title="通知" className="max-w-2xl">
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="px-6 py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>
        )}
        {error && (
          <p className="px-6 py-10 text-center text-sm text-red-500">{error}</p>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-[hsl(var(--muted-foreground))]">
            <BellIcon className="h-10 w-10 opacity-40" />
            <p>暂时没有通知。</p>
          </div>
        )}
        {!loading && !error && items.length > 0 && (
          <ul className="divide-y divide-[hsl(var(--border))]">
            {items.map((item) => {
              const isUnread = item.read_at === null
              const reason = getReason(item)
              const actor = getActorName(item)
              return (
                <li
                  key={item.id}
                  className={`flex gap-3 px-6 py-4 ${isUnread ? 'bg-[hsl(var(--muted))]/40' : ''}`}
                >
                  <div className="mt-1 shrink-0">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${isUnread ? 'bg-red-500' : 'bg-transparent'}`}
                      aria-label={isUnread ? '未读' : '已读'}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-medium text-[hsl(var(--foreground))]">{item.title}</p>
                      <span className="shrink-0 text-xs text-[hsl(var(--muted-foreground))] tabular-nums">{formatRelative(item.created_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[hsl(var(--foreground))]/85">{item.body}</p>
                    {(reason || actor) && (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[hsl(var(--muted-foreground))]">
                        {actor && <span>操作人：{actor}</span>}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {items.length > 0 && (
        <div className="flex items-center justify-between border-t border-[hsl(var(--border))] px-6 py-3">
          <span className="text-xs text-[hsl(var(--muted-foreground))]">共 {data?.total ?? items.length} 条 · 未读 {unread}</span>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={busy || unread === 0}
            className="rounded border border-[hsl(var(--border))] px-3 py-1 text-xs text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] disabled:opacity-50"
          >
            全部标为已读
          </button>
        </div>
      )}
    </PanelShell>
  )
}
