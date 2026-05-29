import JSZip from 'jszip'
import { fetchGalleryBlob, fetchGalleryPage, type PublicGalleryImage } from './galleryApi'
import { formatExportFileTime } from './downloadImages'

const PAGE_SIZE = 60 // 服务端 /api/gallery 的单页上限

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface GalleryDownloadResult {
  successCount: number
  failCount: number
}

// 翻完所有分页，拿到画廊全部图片的元数据（仅 JSON，开销小）
export async function fetchAllGalleryImages(userId?: string): Promise<PublicGalleryImage[]> {
  const all: PublicGalleryImage[] = []
  let offset = 0
  for (;;) {
    const { images, total } = await fetchGalleryPage(PAGE_SIZE, offset, userId)
    all.push(...images)
    offset += images.length
    if (images.length === 0 || all.length >= total) break
  }
  return all
}

function getBlobExtension(blob: Blob): string {
  return MIME_EXTENSIONS[blob.type.toLowerCase()] ?? blob.type.split('/')[1] ?? 'webp'
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

// 下载单张画廊图片（原图）
export async function downloadGalleryImage(id: string): Promise<void> {
  const blob = await fetchGalleryBlob(`/api/gallery/image/${id}`)
  triggerDownload(blob, `picpilot-${id}.${getBlobExtension(blob)}`)
}

// 并发拉取（限流），保持顺序写入结果数组
async function mapWithPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

// 把画廊图片打包成单个 ZIP 一次性下载；失败的单张跳过并计数
export async function downloadGalleryAsZip(
  images: PublicGalleryImage[],
  onProgress?: (done: number, total: number) => void,
): Promise<GalleryDownloadResult> {
  const zip = new JSZip()
  let successCount = 0
  let failCount = 0
  let done = 0

  await mapWithPool(images, 5, async (img, index) => {
    try {
      const blob = await fetchGalleryBlob(`/api/gallery/image/${img.id}`)
      const order = String(index + 1).padStart(String(images.length).length, '0')
      zip.file(`${order}-${img.id}.${getBlobExtension(blob)}`, blob)
      successCount++
    } catch (err) {
      console.error('[downloadGallery] fetch failed:', img.id, err)
      failCount++
    } finally {
      done++
      onProgress?.(done, images.length)
    }
  })

  if (successCount === 0) return { successCount, failCount }

  const archive = await zip.generateAsync({ type: 'blob' })
  triggerDownload(archive, `picpilot-gallery_${formatExportFileTime(new Date())}.zip`)
  return { successCount, failCount }
}
