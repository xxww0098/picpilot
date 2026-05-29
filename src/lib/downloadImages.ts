import JSZip from 'jszip'
import { ensureImageCached } from '../store'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface DownloadImagesResult {
  successCount: number
  failCount: number
}

export function formatExportFileTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

export async function downloadImageIds(imageIds: string[], fileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (imageIds.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const multiple = imageIds.length > 1

  for (let index = 0; index < imageIds.length; index++) {
    try {
      const blob = await getImageBlob(imageIds[index])
      const order = String(index + 1).padStart(2, '0')
      const fileName = multiple
        ? `${fileNameBase}-${order}.${getBlobExtension(blob)}`
        : `${fileNameBase}.${getBlobExtension(blob)}`
      triggerDownload(blob, fileName)
      successCount++
      if (multiple) await delay(100)
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  return { successCount, failCount }
}

// 把多张本地图片打包成单个 ZIP 一次性下载；单张失败跳过并计数
export async function downloadImagesAsZip(
  imageIds: string[],
  fileNameBase = 'images',
  onProgress?: (done: number, total: number) => void,
): Promise<DownloadImagesResult> {
  const zip = new JSZip()
  let successCount = 0
  let failCount = 0
  let done = 0
  const pad = String(imageIds.length).length

  const worker = async (start: number) => {
    for (let i = start; i < imageIds.length; i += 5) {
      try {
        const blob = await getImageBlob(imageIds[i])
        const order = String(i + 1).padStart(pad, '0')
        zip.file(`${order}.${getBlobExtension(blob)}`, blob)
        successCount++
      } catch (err) {
        console.error('[downloadImagesAsZip] failed:', imageIds[i], err)
        failCount++
      } finally {
        done++
        onProgress?.(done, imageIds.length)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(5, imageIds.length)) }, (_, k) => worker(k)),
  )

  if (successCount === 0) return { successCount, failCount }
  const archive = await zip.generateAsync({ type: 'blob' })
  triggerDownload(archive, `${fileNameBase}.zip`)
  return { successCount, failCount }
}

async function getImageBlob(imageIdOrUrl: string): Promise<Blob> {
  let src = imageIdOrUrl
  if (!imageIdOrUrl.startsWith('data:') && !imageIdOrUrl.startsWith('http://') && !imageIdOrUrl.startsWith('https://')) {
    src = await ensureImageCached(imageIdOrUrl) ?? imageIdOrUrl
  }

  const res = await fetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${imageIdOrUrl}`)
  return await res.blob()
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

function getBlobExtension(blob: Blob): string {
  return MIME_EXTENSIONS[blob.type.toLowerCase()] ?? blob.type.split('/')[1] ?? 'png'
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

