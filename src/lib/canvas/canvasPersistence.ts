// 画布文档的持久化辅助：落库前剥离内联 base64 图片 asset，加载时按 asset id 反查图片库恢复。
// 模式参照 src/lib/agent/agentPersistence.ts 的 getPersistableResponseOutputItem。
//
// 关键设计：tldraw 的图片 asset 记录形如
//   { typeName: 'asset', type: 'image', id: 'asset:<imageId>', props: { src: 'data:image/...;base64,...', ... } }
// 我们约定 asset 的 id 后缀就是 picpilot IndexedDB images store 的图片 id（storeImage 返回的 SHA-256）。
// 落库前把 props.src 的 dataUrl 清空（只留 imageId 引用），加载时按 id 从图片库取回 dataUrl 填充。
// 这样画布快照只存结构元数据，大图复用现有 images store，不撑爆 IndexedDB 的 canvases store。

import type { CanvasDocument, TLDSnapshot } from '../../types'
import { getImage } from '../shared/db'

const DATA_URL_PREFIX_RE = /^data:image\//i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 把 tldraw asset id（形如 'asset:<imageId>'）里的 imageId 部分提取出来 */
export function extractImageIdFromAssetId(assetId: string): string | null {
  if (typeof assetId !== 'string') return null
  const idx = assetId.indexOf(':')
  const suffix = idx >= 0 ? assetId.slice(idx + 1) : assetId
  return suffix || null
}

/**
 * 落库前剥离 snapshot 里图片 asset 的内联 dataUrl。
 * 只处理 typeName==='asset' && type==='image' 且 props.src 是 data: 开头的记录。
 * 同时把 props.src 改成 'picpilot-image:<imageId>' 占位，便于加载时识别。
 */
export function getPersistableCanvasSnapshot(snapshot: TLDSnapshot): TLDSnapshot {
  if (!snapshot || !isRecord(snapshot.store)) return snapshot
  const nextStore: Record<string, unknown> = {}
  for (const [id, record] of Object.entries(snapshot.store)) {
    if (!isRecord(record)) {
      nextStore[id] = record
      continue
    }
    if (record.typeName === 'asset' && record.type === 'image') {
      const props = isRecord(record.props) ? record.props : {}
      const src = typeof props.src === 'string' ? props.src : ''
      if (DATA_URL_PREFIX_RE.test(src)) {
        const imageId = extractImageIdFromAssetId(id)
        nextStore[id] = {
          ...record,
          props: { ...props, src: imageId ? `picpilot-image:${imageId}` : '' },
        }
        continue
      }
    }
    nextStore[id] = record
  }
  return { schema: snapshot.schema, store: nextStore }
}

export function getPersistableCanvas(canvas: CanvasDocument): CanvasDocument {
  return {
    ...canvas,
    snapshot: getPersistableCanvasSnapshot(canvas.snapshot),
  }
}

export function getPersistableCanvases(canvases: CanvasDocument[]): CanvasDocument[] {
  return canvases.map(getPersistableCanvas)
}

/**
 * 加载后恢复 snapshot 里图片 asset 的 dataUrl。
 * 遍历所有 'picpilot-image:<imageId>' 占位，按 id 从 IndexedDB images store 取回 dataUrl 填充。
 * 找不到的图片（已被清理）保留占位，不报错——画布上该 asset 会显示空。
 */
export async function hydrateCanvasSnapshot(snapshot: TLDSnapshot): Promise<TLDSnapshot> {
  if (!snapshot || !isRecord(snapshot.store)) return snapshot
  const nextStore: Record<string, unknown> = {}
  const restoreTasks: Array<{ id: string; record: Record<string, unknown>; imageId: string }> = []

  for (const [id, record] of Object.entries(snapshot.store)) {
    if (!isRecord(record)) {
      nextStore[id] = record
      continue
    }
    if (record.typeName === 'asset' && record.type === 'image') {
      const props = isRecord(record.props) ? record.props : {}
      const src = typeof props.src === 'string' ? props.src : ''
      const match = /^picpilot-image:(.+)$/.exec(src)
      if (match) {
        restoreTasks.push({ id, record, imageId: match[1] })
        nextStore[id] = record
        continue
      }
    }
    nextStore[id] = record
  }

  if (restoreTasks.length === 0) return { schema: snapshot.schema, store: nextStore }

  await Promise.all(
    restoreTasks.map(async ({ id, record, imageId }) => {
      try {
        const image = await getImage(imageId)
        if (image?.dataUrl && isRecord(nextStore[id])) {
          const props = isRecord(record.props) ? record.props : {}
          nextStore[id] = { ...record, props: { ...props, src: image.dataUrl } }
        }
      } catch {
        // 找不到图片保留占位，不阻塞画布加载
      }
    }),
  )

  return { schema: snapshot.schema, store: nextStore }
}

/** 规范化从 IndexedDB 读出的画布文档，容错异常结构 */
export function normalizeCanvas(value: unknown): CanvasDocument | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : null
  if (!id) return null
  const title = typeof value.title === 'string' ? value.title : '未命名画布'
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now()
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : createdAt
  const snapshot = isRecord(value.snapshot) && isRecord(value.snapshot.store)
    ? { schema: value.snapshot.schema ?? {}, store: value.snapshot.store as Record<string, unknown> }
    : { schema: {}, store: {} }
  return { id, title, createdAt, updatedAt, snapshot }
}

export function normalizeCanvases(values: unknown[]): CanvasDocument[] {
  return values.map(normalizeCanvas).filter((c): c is CanvasDocument => c !== null)
}

/** 合并 IndexedDB 与内存中的画布，按 updatedAt 取新（参照 mergeAgentConversationsForStorage） */
export function mergeCanvasesForStorage(stored: CanvasDocument[], memory: CanvasDocument[]): CanvasDocument[] {
  const merged = new Map<string, CanvasDocument>()
  for (const canvas of stored) merged.set(canvas.id, canvas)
  for (const canvas of memory) {
    const existing = merged.get(canvas.id)
    if (!existing || canvas.updatedAt >= existing.updatedAt) {
      merged.set(canvas.id, canvas)
    }
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}
