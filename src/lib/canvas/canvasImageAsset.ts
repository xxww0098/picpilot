// 画布图片 asset 与 shape 操作：从 tldraw editor 取选中图的 dataUrl、创建 image shape 填入占位框。
// 与 cowart insertCowartImage 的 shape 构造对齐，但简化为 picpilot 的纯前端 + dataUrl 体系。
import type { Editor, TLAssetId, TLPageId, TLParentId } from 'tldraw'

/** AI 占位框的 tldraw shape meta 标记（cowart 沿用）。frame shape 带此标记即视为占位框。 */
export const AI_IMAGE_HOLDER_META_KEY = 'cowartAiImageHolder'

interface SelectedImageInfo {
  /** 图片 dataUrl（base64） */
  dataUrl: string
  /** image asset id（用于持久化恢复） */
  assetId: string
  /** 该 image shape 在页面坐标系下的包围盒 */
  bounds: { x: number; y: number; w: number; h: number }
  /** shape id */
  shapeId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 判断 shape 是否为 AI 占位框（cowart 沿用 meta 标记） */
export function isAiImageHolder(shape: unknown): boolean {
  if (!isRecord(shape)) return false
  const meta = isRecord(shape.meta) ? shape.meta : {}
  return meta[AI_IMAGE_HOLDER_META_KEY] === true || (shape as { isAiImageHolder?: boolean }).isAiImageHolder === true
}

/**
 * 从 editor 选中的 shape 里取出第一张 image 的 dataUrl + 元信息。
 * 用于「选中图 → 基于它再生成」（图生图）。
 * 返回 null 表示当前没有选中的图片 shape。
 */
export function getSelectedImageDataUrl(editor: Editor): SelectedImageInfo | null {
  const selected = editor.getSelectedShapes()
  const imageShape = selected.find((shape) => shape.type === 'image')
  if (!imageShape) return null

  const assetId = (imageShape.props as { assetId?: TLAssetId } | undefined)?.assetId
  if (!assetId) return null

  const asset = editor.getAsset(assetId as TLAssetId)
  if (!asset || asset.type !== 'image') return null

  const src = (asset.props as { src?: string } | undefined)?.src
  if (typeof src !== 'string' || !src.startsWith('data:')) return null

  const pageBounds = editor.getShapePageBounds(imageShape.id)
  if (!pageBounds) return null

  return {
    dataUrl: src,
    assetId,
    bounds: { x: pageBounds.x, y: pageBounds.y, w: pageBounds.width, h: pageBounds.height },
    shapeId: imageShape.id,
  }
}

/**
 * 取当前选中的 AI 占位框（若有且仅一个）。
 */
export function getSelectedAiHolder(editor: Editor): { id: string; w: number; h: number; parentId: string } | null {
  const selected = editor.getSelectedShapes()
  const holder = selected.length === 1 && isAiImageHolder(selected[0]) ? selected[0] : null
  if (!holder) return null
  const props = holder.props as { w?: number; h?: number } | undefined
  return {
    id: holder.id,
    w: props?.w ?? 320,
    h: props?.h ?? 220,
    parentId: holder.parentId,
  }
}

/**
 * 把生成图作为 tldraw image shape 插入画布。
 * - 若提供 holder：作为 holder 的子 shape 填满占位框（frame holder 模式）
 * - 否则：作为独立 image shape 放在锚点旁或页面空闲处
 *
 * assetId 约定用 picpilot 的 imageId 作后缀，便于持久化时剥离/恢复 dataUrl。
 */
export function insertCanvasImage(
  editor: Editor,
  args: {
    imageId: string
    dataUrl: string
    /** 自然像素尺寸（用于 asset 记录） */
    naturalWidth: number
    naturalHeight: number
    /** 显示尺寸 */
    displayWidth: number
    displayHeight: number
    /** 目标 holder（填入占位框模式） */
    holder?: { id: string } | null
    /** 锚点 shape（图生图迭代时，新图放在它旁边） */
    anchorShapeId?: string | null
    placement?: 'right' | 'left' | 'below'
    margin?: number
    altText?: string
  },
): string {
  const assetId = `asset:${args.imageId}` as TLAssetId

  // 创建 image asset
  editor.createAssets([
    {
      id: assetId,
      type: 'image',
      typeName: 'asset',
      props: {
        name: `canvas-${args.imageId}.png`,
        src: args.dataUrl,
        w: args.naturalWidth,
        h: args.naturalHeight,
        mimeType: 'image/png',
        isAnimated: false,
      },
      meta: {},
    } as Parameters<Editor['createAssets']>[0][number],
  ])

  // 计算 image shape 位置
  let x = 0
  let y = 0
  let parentId: TLParentId = editor.getCurrentPageId() as TLPageId
  let rotation = 0

  if (args.holder) {
    // 填入 frame 占位框：作为 frame 的子 shape，坐标 (0,0)
    parentId = args.holder.id as unknown as TLParentId
    x = 0
    y = 0
    rotation = 0
  } else if (args.anchorShapeId) {
    const anchor = editor.getShape(args.anchorShapeId as Parameters<Editor['getShape']>[0])
    const anchorBounds = anchor ? editor.getShapePageBounds(anchor.id) : null
    if (anchorBounds) {
      const margin = args.margin ?? 40
      const placement = args.placement ?? 'right'
      if (placement === 'right') {
        x = anchorBounds.maxX + margin
        y = anchorBounds.y
      } else if (placement === 'left') {
        x = anchorBounds.minX - args.displayWidth - margin
        y = anchorBounds.y
      } else {
        x = anchorBounds.x
        y = anchorBounds.maxY + margin
      }
      parentId = (anchor?.parentId ?? parentId) as TLParentId
    }
  }

  const shapeId = editor.createShape({
    type: 'image',
    x,
    y,
    rotation,
    parentId,
    props: {
      w: args.displayWidth,
      h: args.displayHeight,
      assetId,
      playing: true,
      url: '',
      crop: null,
      flipX: false,
      flipY: false,
    },
    meta: args.holder
      ? { cowartGeneratedForAiImageHolder: args.holder.id }
      : { cowartGeneratedStandalone: true },
  }).id

  return shapeId
}
