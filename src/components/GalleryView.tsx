import { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch, fetchCurrentUser } from '../lib/auth'
import { CloseIcon } from './icons'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'

interface PublicImage {
  id: string
  user_id: string
  username: string
  prompt: string
  width: number | null
  height: number | null
  file_size: number | null
  created_at: number
}

const PAGE_SIZE = 24

interface Props {
  open: boolean
  onClose: () => void
}

// 鉴权后获取图片，转成 objectURL 给 <img>
function AuthImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let aborted = false
    let objectUrl: string | null = null
    authFetch(src)
      .then((res) => {
        if (!res.ok) throw new Error('加载失败')
        return res.blob()
      })
      .then((blob) => {
        if (aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      aborted = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  if (!url) return <div className={`bg-[hsl(var(--muted))] ${className ?? ''}`} />
  return <img src={url} alt={alt} className={className} />
}

export default function GalleryView({ open, onClose }: Props) {
  const [images, setImages] = useState<PublicImage[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<PublicImage | null>(null)
  const [me, setMe] = useState<{ userId: string; isAdmin: boolean } | null>(null)

  useCloseOnEscape(open, onClose)
  usePreventBackgroundScroll(open)

  useEffect(() => {
    if (!open) return
    void fetchCurrentUser().then((u) => {
      if (u && 'userId' in u) setMe({ userId: u.userId, isAdmin: u.isAdmin })
    })
  }, [open])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch(`/api/gallery?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      if (!res.ok) throw new Error('加载失败')
      const data = (await res.json()) as { images: PublicImage[]; total: number }
      setImages(data.images)
      setTotal(data.total)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  async function deleteImage(id: string) {
    if (!confirm('确定删除这张公开图？')) return
    try {
      const res = await authFetch(`/api/gallery/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '删除失败')
      }
      if (detail?.id === id) setDetail(null)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  const maxPage = useMemo(() => Math.max(0, Math.ceil(total / PAGE_SIZE) - 1), [total])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/40 backdrop-blur-sm">
      <div className="m-4 flex w-full max-w-6xl flex-col rounded-2xl border border-[hsl(var(--border))] bg-white shadow-xl dark:bg-[hsl(240_10%_12%)]">
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-6 py-4">
          <h2 className="text-lg font-semibold text-[hsl(var(--foreground))]">公开画廊</h2>
          <button onClick={onClose} className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {!loading && !error && images.length === 0 && (
            <p className="py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">还没有公开图。生成图片后点"公开到画廊"上传。</p>
          )}
          {!loading && !error && images.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {images.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setDetail(img)}
                  className="group relative overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] aspect-square"
                >
                  <AuthImage
                    src={`/api/gallery/image/${img.id}?thumb=1`}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                    <p className="truncate text-xs text-white">{img.username}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {maxPage > 0 && (
            <div className="mt-6 flex items-center justify-between text-sm">
              <span className="text-[hsl(var(--muted-foreground))]">共 {total} 张 · 第 {page + 1} / {maxPage + 1} 页</span>
              <div className="flex gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="rounded border border-[hsl(var(--border))] px-3 py-1 disabled:opacity-50">上一页</button>
                <button disabled={page >= maxPage} onClick={() => setPage((p) => Math.min(maxPage, p + 1))} className="rounded border border-[hsl(var(--border))] px-3 py-1 disabled:opacity-50">下一页</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-[hsl(240_10%_12%)] md:flex-row" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-1 items-center justify-center bg-black p-4">
              <AuthImage src={`/api/gallery/image/${detail.id}`} className="max-h-[80vh] max-w-full object-contain" />
            </div>
            <div className="flex w-full flex-col gap-3 overflow-y-auto p-6 md:w-80">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-[hsl(var(--foreground))]">{detail.username}</p>
                <button onClick={() => setDetail(null)} className="rounded p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"><CloseIcon className="h-4 w-4" /></button>
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">{new Date(detail.created_at).toLocaleString()}</p>
              {detail.width && detail.height && (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{detail.width}×{detail.height}</p>
              )}
              <div>
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Prompt</p>
                <p className="whitespace-pre-wrap rounded bg-[hsl(var(--muted))] p-3 text-sm text-[hsl(var(--foreground))]">{detail.prompt}</p>
              </div>
              {me && (detail.user_id === me.userId || me.isAdmin) && (
                <button
                  onClick={() => void deleteImage(detail.id)}
                  className="mt-auto rounded bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
