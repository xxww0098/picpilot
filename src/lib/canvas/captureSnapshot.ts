// 画布截图：用 tldraw 的 getSvgString + getSvgAsImage 把选中区域（图 + 其上的标注）导出成 PNG dataUrl。
// 用于「标注迭代」：截图含原图 + 红色箭头/文字批注 → 发给 AI → AI 读标注生成干净修订版。
import { getSvgAsImage, type Editor, type TLShapeId } from 'tldraw'
import { loadImage } from '../imaging/canvasImage'

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** background: true=白色不透明背景（确保标注清晰）；false=透明 */
interface CaptureOpts {
  background?: boolean
  pixelRatio?: number
}

/**
 * 截取当前选中的所有 shape（含图片 + 标注箭头/文字）为 PNG dataUrl。
 * 返回 null 表示没有选中内容或导出失败。
 */
export async function captureSelectionAsDataUrl(
  editor: Editor,
  opts: CaptureOpts = {},
): Promise<string | null> {
  const selectedIds = editor.getSelectedShapeIds()
  if (selectedIds.length === 0) return null

  const result = await editor.getSvgString(selectedIds as TLShapeId[], {
    background: opts.background ?? true,
  })
  if (!result?.svg) return null

  const blob = await getSvgAsImage(result.svg, {
    type: 'png',
    width: result.width,
    height: result.height,
    pixelRatio: opts.pixelRatio ?? 2,
    quality: 1,
  })
  if (!blob) return null

  return blobToDataUrl(blob)
}

/**
 * 截取指定 shape 及其邻近标注（cowart 模式：截一张图 + 它上方的箭头/批注）。
 * 选中一张 image shape 时，自动把它和画面上所有箭头/文字/标注 shape 一起截。
 */
export async function captureImageWithAnnotations(
  editor: Editor,
  imageShapeId: string,
  opts: CaptureOpts = {},
): Promise<string | null> {
  const imageShape = editor.getShape(imageShapeId as Parameters<Editor['getShape']>[0])
  if (!imageShape) return null

  // 收集要截图的 shape：目标图 + 当前页所有箭头/文字/标注类 shape
  const pageShapes = editor.getCurrentPageShapes()
  const annotationTypes = new Set(['arrow', 'text', 'draw', 'note', 'highlight'])
  const idsToCapture = [
    imageShape.id,
    ...pageShapes.filter((s) => annotationTypes.has(s.type)).map((s) => s.id),
  ]

  const result = await editor.getSvgString(idsToCapture as TLShapeId[], {
    background: opts.background ?? true,
  })
  if (!result?.svg) return null

  const blob = await getSvgAsImage(result.svg, {
    type: 'png',
    width: result.width,
    height: result.height,
    pixelRatio: opts.pixelRatio ?? 2,
    quality: 1,
  })
  if (!blob) return null

  return blobToDataUrl(blob)
}

/** 从 dataUrl 读取自然像素尺寸 */
export async function getDataUrlNaturalSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const img = await loadImage(dataUrl)
  return { width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 }
}
