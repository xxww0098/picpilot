import { useState } from 'react'
import { ensureImageCached } from '../../store'
import { publishGalleryImage } from '../../lib/server/galleryApi'
import { showAppToast } from '../../lib/ui/dialog'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import { useAuth } from '../../contexts/AuthProvider'

interface Props {
  imageId: string
  prompt: string
  // 生成该图时 @ 引用的原图 id（输入图），会随主图一起公开到画廊
  originalImageIds?: string[]
  onSuccess?: () => void
  className?: string
}

// 上传单张图到公开画廊；button 内置上传逻辑，调用方只需提供 imageId + prompt（+ 可选原图）
export default function PublishGalleryButton({ imageId, prompt, originalImageIds, onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const { refresh } = useAuth()

  async function publish() {
    if (loading || done) return
    setLoading(true)
    try {
      const dataUrl = await ensureImageCached(imageId)
      if (!dataUrl) throw new Error('找不到原图，可能已被清理。')
      // 取回 @ 引用的原图数据；个别取不到的（已清理）跳过，不阻断主图公开
      const originals = (
        await Promise.all((originalImageIds ?? []).map((id) => ensureImageCached(id).catch(() => null)))
      ).filter((url): url is string => Boolean(url))
      await publishGalleryImage(dataUrl, prompt, originals)
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
