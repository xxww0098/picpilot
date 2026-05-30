import { authJson } from './apiClient'

export type NotificationType = 'gallery_revoked' | string

export interface GalleryRevokedMetadata {
  image_id: string
  prompt_excerpt: string
  reason: string | null
  actor_username: string | null
  actor_display_name: string | null
}

export interface NotificationItem {
  id: number
  type: NotificationType
  title: string
  body: string
  metadata: GalleryRevokedMetadata | Record<string, unknown> | null
  read_at: number | null
  created_at: number
}

export interface NotificationsPage {
  items: NotificationItem[]
  total: number
  unread: number
}

export function fetchNotifications(limit = 30, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return authJson<NotificationsPage>(`/api/notifications?${params}`, undefined, '加载通知失败，请稍后重试')
}

export function fetchUnreadCount() {
  return authJson<{ unread: number }>('/api/notifications/unread-count', undefined, '加载通知失败')
}

export function markNotificationsRead(ids?: number[]) {
  return authJson<{ ok: true; updated: number }>('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
  }, '更新通知状态失败')
}

export function adminRevokeGalleryImage(id: string, reason?: string) {
  return authJson<{ ok: true }>(`/api/admin/gallery/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason ?? '' }),
  }, '撤下公开图失败，请稍后重试')
}

export function adminSetGalleryFeatured(id: string, featured: boolean) {
  return authJson<{ ok: true; featured: boolean }>(`/api/admin/gallery/${encodeURIComponent(id)}/feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featured }),
  }, '设置推荐失败，请稍后重试')
}
