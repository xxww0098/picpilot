import { authFetch } from './auth'
import { authJson } from './apiClient'

export interface PublicGalleryOriginal {
  id: string
  width: number | null
  height: number | null
}

export interface PublicGalleryImage {
  id: string
  user_id: string
  username: string
  display_name?: string | null
  avatar_updated_at: number | null
  prompt: string
  width: number | null
  height: number | null
  file_size: number | null
  created_at: number
  originals?: PublicGalleryOriginal[]
}

export function fetchGalleryPage(limit: number, offset: number, userId?: string) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })
  if (userId) params.set('user_id', userId)
  return authJson<{ images: PublicGalleryImage[]; total: number }>(
    `/api/gallery?${params}`,
    undefined,
    '加载作品广场失败，请稍后重试',
  )
}

export function publishGalleryImage(imageBase64: string, prompt: string, originals?: string[]) {
  return authJson<{ id: string }>('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: imageBase64, prompt, originals: originals ?? [] }),
  }, '发布到作品广场失败，请稍后重试')
}

export function deleteGalleryImage(id: string) {
  return authJson<{ ok: true }>(`/api/gallery/${id}`, { method: 'DELETE' }, '删除作品失败，请稍后重试')
}

export async function fetchGalleryBlob(url: string): Promise<Blob> {
  const res = await authFetch(url)
  if (!res.ok) throw new Error('加载图片失败，请刷新后重试')
  return res.blob()
}
