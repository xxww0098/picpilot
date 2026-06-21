// 画布布局工具：在现有 shape 中为新图找避障位置，生成 tldraw fractional index。
// 移植自 cowart 的 mcp/server.mjs（choosePlacement / pageBoundsForShape / chooseIndex），
// 适配 TypeScript + tldraw v5 的 record 结构（运行时松散结构，用 record 访问）。
import { generateKeyBetween } from 'fractional-indexing'

// tldraw shape record 的运行时松散视图（字段按 tldraw schema 存在，但类型用 unknown 收敛）
interface TldrawShape {
  id: string
  typeName?: string
  type?: string
  parentId?: string
  index?: string
  x?: number
  y?: number
  rotation?: number
  props?: Record<string, unknown> & {
    w?: number
    h?: number
    start?: { x: number; y: number }
    end?: { x: number; y: number }
  }
}

interface TldrawStore {
  [id: string]: unknown
}

interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isShape(value: unknown): value is TldrawShape {
  return typeof value === 'object' && value !== null && (value as TldrawShape).typeName === 'shape'
}

function localBoundsForShape(shape: TldrawShape): Bounds | null {
  if (!shape) return null
  const props = shape.props ?? {}
  // 箭头：用 start/end 算包围盒
  if (shape.type === 'arrow') {
    const start = (props.start ?? { x: 0, y: 0 }) as { x: number; y: number }
    const end = (props.end ?? { x: 0, y: 0 }) as { x: number; y: number }
    const minX = Math.min(start.x ?? 0, end.x ?? 0)
    const minY = Math.min(start.y ?? 0, end.y ?? 0)
    const maxX = Math.max(start.x ?? 0, end.x ?? 0)
    const maxY = Math.max(start.y ?? 0, end.y ?? 0)
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }
  const w = finiteNumber(props.w, shape.type === 'text' ? 160 : 1)
  const h = finiteNumber(props.h, shape.type === 'text' ? 40 : 1)
  return { x: 0, y: 0, w, h }
}

/** 计算 shape 在页面坐标系下的包围盒（累加祖先 x/y） */
export function pageBoundsForShape(store: TldrawStore, shape: TldrawShape): Bounds | null {
  const local = localBoundsForShape(shape)
  if (!local) return null
  let x = finiteNumber(shape.x, 0) + local.x
  let y = finiteNumber(shape.y, 0) + local.y
  let parent = store[shape.parentId ?? '']
  const visited = new Set([shape.id])
  while (isShape(parent) && !visited.has(parent.id)) {
    visited.add(parent.id)
    x += finiteNumber(parent.x, 0)
    y += finiteNumber(parent.y, 0)
    parent = store[parent.parentId ?? '']
  }
  return { x, y, w: local.w, h: local.h }
}

function rectsOverlap(a: Bounds, b: Bounds, padding = 0): boolean {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  )
}

/** 在同一 parent 下生成下一个 fractional index（排在所有兄弟之后） */
export function chooseIndex(store: TldrawStore, parentId: string): string {
  const siblingIndexes = Object.values(store)
    .filter((record): record is TldrawShape =>
      isShape(record) && record.parentId === parentId && typeof record.index === 'string',
    )
    .map((record) => record.index as string)
    .sort()
  return generateKeyBetween(siblingIndexes[siblingIndexes.length - 1] ?? null, null)
}

export type PlacementDirection = 'right' | 'left' | 'below'

export interface ChoosePlacementOptions {
  store: TldrawStore
  pageId: string
  parentId: string
  /** 锚点 shape（通常是被迭代的原图）；无锚点时放在页面左上 */
  anchorShape?: TldrawShape | null
  width: number
  height: number
  margin?: number
  placement?: PlacementDirection
}

/**
 * 在页面中为新 shape 找避障位置。
 * 策略（移植自 cowart）：从锚点右侧（或指定方向）开始，沿该方向步进直到不与现有 shape 重叠。
 */
export function choosePlacement(opts: ChoosePlacementOptions): Bounds {
  const { store, pageId, parentId, anchorShape, width, height } = opts
  const margin = Math.max(0, opts.margin ?? 40)
  const placement: PlacementDirection = opts.placement ?? 'right'

  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null
  let x = anchorBounds ? anchorBounds.x + anchorBounds.w + margin : 0
  let y = anchorBounds ? anchorBounds.y : 0

  if (placement === 'left' && anchorBounds) x = anchorBounds.x - width - margin
  if (placement === 'below' && anchorBounds) {
    x = anchorBounds.x
    y = anchorBounds.y + anchorBounds.h + margin
  }

  // 收集同 parent 下所有 shape 的页面包围盒作为障碍
  const pageShapes: TldrawShape[] = []
  for (const record of Object.values(store)) {
    if (isShape(record) && record.parentId === pageId) pageShapes.push(record)
  }
  const obstacles = pageShapes
    .filter((shape) => shape.parentId === parentId && shape.id !== anchorShape?.id)
    .map((shape) => pageBoundsForShape(store, shape))
    .filter((b): b is Bounds => b !== null)

  const stepX = Math.max(width + margin, 1)
  const stepY = Math.max(height + margin, 1)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, w: width, h: height }
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, margin / 2))) {
      return candidate
    }
    if (placement === 'below') y += stepY
    else if (placement === 'left') x -= stepX
    else x += stepX
  }

  return { x, y, w: width, h: height }
}

/**
 * 把 dataUrl 尺寸（像素）按占位框宽高比映射到 picpilot 支持的标准出图尺寸。
 * 占位框宽高比 → 选最近的 1:1 / 3:2 / 2:3 标准尺寸。
 */
export function mapHolderRatioToOutputSize(holderW: number, holderH: number): { width: number; height: number } | undefined {
  const ratio = holderW / holderH
  // picpilot 常见尺寸（与 src/lib/params/paramCompatibility 对齐）
  if (ratio > 1.4) return { width: 1536, height: 1024 } // 3:2 横
  if (ratio < 0.7) return { width: 1024, height: 1536 } // 2:3 竖
  return { width: 1024, height: 1024 } // 1:1
}

/** 把 {width,height} 转成 picpilot params.size 字符串 */
export function sizeToString(size: { width: number; height: number }): string {
  return `${size.width}x${size.height}`
}
