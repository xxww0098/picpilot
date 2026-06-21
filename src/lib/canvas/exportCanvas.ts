// 单画布文档的导出/导入（JSON 文件）。
// 用于画布间快速分享：导出当前画布的 tldraw 快照（不含内联 dataUrl，图片靠 imageId 引用，
// 导入方需有相同图片库或接受图片缺失）。
import type { CanvasDocument } from '../../types'
import { getPersistableCanvas, hydrateCanvasSnapshot, normalizeCanvas } from './canvasPersistence'

const CANVAS_FILE_SIGNATURE = 'picpilot-canvas'
const CANVAS_FILE_VERSION = 1

interface CanvasFilePayload {
  signature: typeof CANVAS_FILE_SIGNATURE
  version: number
  canvas: CanvasDocument
}

export interface CanvasExportResult {
  blob: Blob
  filename: string
}

/** 导出单个画布文档为 JSON 文件 */
export function exportCanvasToFile(canvas: CanvasDocument): CanvasExportResult {
  const payload: CanvasFilePayload = {
    signature: CANVAS_FILE_SIGNATURE,
    version: CANVAS_FILE_VERSION,
    canvas: getPersistableCanvas(canvas),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const safeTitle = canvas.title.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'canvas'
  const filename = `${safeTitle}_${new Date(canvas.createdAt).toISOString().slice(0, 10)}.json`
  return { blob, filename }
}

/** 触发浏览器下载画布文件 */
export function downloadCanvasFile(canvas: CanvasDocument): void {
  const { blob, filename } = exportCanvasToFile(canvas)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 解析画布 JSON 文件。
 * 返回 null 表示格式不合法。
 * 注意：返回的 snapshot 是剥离了 dataUrl 的结构，调用方（init / 首次加载）需 hydrate 恢复图片。
 */
export async function parseCanvasFile(file: File): Promise<CanvasDocument | null> {
  let payload: CanvasFilePayload
  try {
    const text = await file.text()
    payload = JSON.parse(text) as CanvasFilePayload
  } catch {
    return null
  }
  if (payload?.signature !== CANVAS_FILE_SIGNATURE) return null
  const canvas = normalizeCanvas(payload.canvas)
  if (!canvas) return null
  // 生成新 id 避免与现有画布冲突；保留标题和内容
  const imported: CanvasDocument = {
    ...canvas,
    id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: canvas.title.endsWith('（导入）') ? canvas.title : `${canvas.title}（导入）`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  // 尝试恢复图片 asset dataUrl
  imported.snapshot = await hydrateCanvasSnapshot(canvas.snapshot)
  return imported
}
