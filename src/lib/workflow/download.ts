import type { WorkflowImage } from './types'

// ============================================================================
// 工作流图片下载:把节点产物(base64 dataURL)落地为文件。
// 纯函数(inferExtFromDataUrl / workflowImageFilename)可单测;downloadDataUrl 触发浏览器下载。
// ============================================================================

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** 从 data URL 的 MIME 推断文件扩展名。 */
export function inferExtFromDataUrl(dataUrl: string): string {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl)
  const mime = m?.[1]?.toLowerCase() ?? ''
  if (MIME_EXT[mime]) return MIME_EXT[mime]
  return mime.startsWith('image/') ? mime.slice('image/'.length) : 'png'
}

/** 生成安全的下载文件名(保留中文/字母数字,其余转下划线)。 */
export function workflowImageFilename(label: string, index: number, dataUrl: string): string {
  const safe = (label || 'image')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'image'
  return `picpilot-${safe}-${index + 1}.${inferExtFromDataUrl(dataUrl)}`
}

/** 触发单张 data URL 下载。 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** 顺序下载一组图片(用于输出节点「下载全部」)。 */
export function downloadWorkflowImages(images: WorkflowImage[], label: string): void {
  images.forEach((img, i) => {
    // 轻微错开,避免部分浏览器并发多次下载被拦截。
    window.setTimeout(() => downloadDataUrl(img.dataUrl, workflowImageFilename(label, i, img.dataUrl)), i * 120)
  })
}
