import { stripImages } from './runtime'
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraph, type WorkflowNode } from './types'

// ============================================================================
// 多工作流库(借鉴 infinite-canvas 的「我的画布」多画布能力)。
// localStorage 结构:
//   picpilot.workflow.index.v1  → { activeId, items: WorkflowMeta[] }
//   picpilot.workflow.wf.<id>   → 精简图(stripImages,不含图片 dataURL)
// 首次加载时把旧单图键 picpilot.workflow.graph.v1 迁移成第一个工作流。
// ============================================================================

export type WorkflowMeta = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

type StoreIndex = { activeId: string; items: WorkflowMeta[] }

const INDEX_KEY = 'picpilot.workflow.index.v1'
const GRAPH_PREFIX = 'picpilot.workflow.wf.'
const LEGACY_GRAPH_KEY = 'picpilot.workflow.graph.v1'

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readIndex(): StoreIndex | null {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoreIndex>
    if (!parsed || typeof parsed.activeId !== 'string' || !Array.isArray(parsed.items)) return null
    return { activeId: parsed.activeId, items: parsed.items as WorkflowMeta[] }
  } catch {
    return null
  }
}

function writeIndex(idx: StoreIndex): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx))
  } catch {
    /* quota / unavailable: ignore */
  }
}

function graphKey(id: string): string {
  return GRAPH_PREFIX + id
}

function leanGraph(graph: WorkflowGraph): WorkflowGraph {
  return { version: WORKFLOW_GRAPH_VERSION, nodes: graph.nodes.map(stripImages), edges: graph.edges }
}

/** 初始化并(必要时)迁移旧单图;始终返回至少含一个工作流的索引。 */
export function ensureStore(): StoreIndex {
  const existing = readIndex()
  if (existing && existing.items.length > 0) {
    if (!existing.items.some((w) => w.id === existing.activeId)) existing.activeId = existing.items[0].id
    return existing
  }
  const now = Date.now()
  const id = uid()
  const idx: StoreIndex = { activeId: id, items: [{ id, name: '我的工作流', createdAt: now, updatedAt: now }] }
  // 迁移旧的单图键(若存在)
  try {
    const legacy = localStorage.getItem(LEGACY_GRAPH_KEY)
    if (legacy) {
      localStorage.setItem(graphKey(id), legacy)
      localStorage.removeItem(LEGACY_GRAPH_KEY)
    }
  } catch {
    /* ignore */
  }
  writeIndex(idx)
  return idx
}

export function listWorkflows(): WorkflowMeta[] {
  return ensureStore().items.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getActiveId(): string {
  return ensureStore().activeId
}

export function setActiveId(id: string): void {
  const idx = ensureStore()
  if (!idx.items.some((w) => w.id === id)) return
  idx.activeId = id
  writeIndex(idx)
}

export function loadWorkflowGraph(id: string): WorkflowGraph | null {
  try {
    const raw = localStorage.getItem(graphKey(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WorkflowGraph>
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return { version: WORKFLOW_GRAPH_VERSION, nodes: parsed.nodes as WorkflowNode[], edges: parsed.edges }
  } catch {
    return null
  }
}

/** 保存某工作流图(剥离图片)并更新其 updatedAt。 */
export function saveWorkflowGraph(id: string, graph: WorkflowGraph): void {
  try {
    localStorage.setItem(graphKey(id), JSON.stringify(leanGraph(graph)))
  } catch {
    /* ignore */
  }
  const idx = ensureStore()
  const meta = idx.items.find((w) => w.id === id)
  if (meta) {
    meta.updatedAt = Date.now()
    writeIndex(idx)
  }
}

export function createWorkflow(name?: string): WorkflowMeta {
  const idx = ensureStore()
  const now = Date.now()
  const meta: WorkflowMeta = { id: uid(), name: (name ?? '').trim() || `工作流 ${idx.items.length + 1}`, createdAt: now, updatedAt: now }
  idx.items.push(meta)
  idx.activeId = meta.id
  writeIndex(idx)
  return meta
}

export function renameWorkflow(id: string, name: string): void {
  const idx = ensureStore()
  const meta = idx.items.find((w) => w.id === id)
  if (!meta) return
  const trimmed = name.trim()
  if (!trimmed) return
  meta.name = trimmed.slice(0, 60)
  meta.updatedAt = Date.now()
  writeIndex(idx)
}

/** 删除一个工作流;返回删除后的活动 id(必要时新建空工作流以保证至少一个)。 */
export function deleteWorkflow(id: string): string {
  const idx = ensureStore()
  idx.items = idx.items.filter((w) => w.id !== id)
  try {
    localStorage.removeItem(graphKey(id))
  } catch {
    /* ignore */
  }
  if (idx.items.length === 0) {
    const now = Date.now()
    const meta: WorkflowMeta = { id: uid(), name: '我的工作流', createdAt: now, updatedAt: now }
    idx.items.push(meta)
    idx.activeId = meta.id
  } else if (idx.activeId === id) {
    idx.activeId = idx.items[0].id
  }
  writeIndex(idx)
  return idx.activeId
}

export function duplicateWorkflow(id: string): WorkflowMeta {
  const idx = ensureStore()
  const src = idx.items.find((w) => w.id === id)
  const now = Date.now()
  const meta: WorkflowMeta = { id: uid(), name: `${src?.name ?? '工作流'}（副本）`.slice(0, 60), createdAt: now, updatedAt: now }
  try {
    const raw = localStorage.getItem(graphKey(id))
    if (raw) localStorage.setItem(graphKey(meta.id), raw)
  } catch {
    /* ignore */
  }
  idx.items.push(meta)
  idx.activeId = meta.id
  writeIndex(idx)
  return meta
}
