import { readBlobAsDataUrl } from './dataUrl'

const DEFAULT_MAX_LONG_EDGE = 2048
const JPEG_QUALITY = 0.9
const MIN_BYTES_TO_REENCODE = 1.5 * 1024 * 1024

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片预处理失败'))
    }, type, quality)
  })
}

export async function preprocessImageFile(file: File, maxLongEdge = DEFAULT_MAX_LONG_EDGE): Promise<{ dataUrl: string; resized: boolean }> {
  const original = await readBlobAsDataUrl(file)
  if (/image\/(gif|svg\+xml)/i.test(file.type)) return { dataUrl: original, resized: false }

  const image = await loadImage(original)
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge && file.size < MIN_BYTES_TO_REENCODE) {
    return { dataUrl: original, resized: false }
  }

  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dataUrl: original, resized: false }
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight)

  const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY)
  if (blob.size >= file.size && longEdge <= maxLongEdge) return { dataUrl: original, resized: false }
  return { dataUrl: await readBlobAsDataUrl(blob), resized: true }
}
