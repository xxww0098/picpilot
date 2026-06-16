import { fetchGalleryBlob } from '../server/galleryApi'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
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

// 下载单张公开画廊图片（原图）—— 供画廊卡片右键菜单使用
export async function downloadGalleryImage(id: string): Promise<void> {
  const blob = await fetchGalleryBlob(`/api/gallery/image/${id}`)
  triggerDownload(blob, `picpilot-${id}.${getBlobExtension(blob)}`)
}
