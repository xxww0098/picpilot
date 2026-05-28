import { useState } from 'react'
import { ensureImageCached } from '../store'
import { publishGalleryImage } from '../lib/galleryApi'
import { showAppToast } from '../lib/dialog'
import { getUserFacingErrorMessage } from '../lib/userFacingText'
import { useAuth } from '../contexts/AuthProvider'

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
  const { refresh } = useAuth()

  async function publish() {
    if (loading || done) return
    setLoading(true)
    try {
      const dataUrl = await ensureImageCached(imageId)
      if (!dataUrl) throw new Error('找不到原图，可能已被清理。')
      await publishGalleryImage(dataUrl, prompt)
      await refresh()
      setDone(true)
      onSuccess?.()
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '公开到画廊失败'), 'error')
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
