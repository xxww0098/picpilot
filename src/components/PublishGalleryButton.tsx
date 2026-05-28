import { useState } from 'react'
import { ensureImageCached } from '../store'
import { authFetch } from '../lib/auth'

interface Props {
  imageId: string
  prompt: string
  onSuccess?: () => void
  className?: string
}

// 上传单张图到公开画廊；button 内置上传逻辑，调用方只需提供 imageId + prompt
export default function PublishGalleryButton({ imageId, prompt, onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  async function publish() {
    if (loading || done) return
    setLoading(true)
    try {
      const dataUrl = await ensureImageCached(imageId)
      if (!dataUrl) throw new Error('找不到原图')
      const res = await authFetch('/api/gallery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: dataUrl, prompt }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '上传失败')
      }
      setDone(true)
      onSuccess?.()
    } catch (e) {
      alert(e instanceof Error ? e.message : '上传失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void publish()}
      disabled={loading || done}
      className={
        className ??
        'flex items-center gap-1 rounded bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur-sm transition hover:bg-black/70 disabled:opacity-50'
      }
      aria-label="公开到画廊"
    >
      {loading ? '上传中…' : done ? '已公开' : '公开到画廊'}
    </button>
  )
}
