import { callImageApi } from '../image/api'
import { DEFAULT_PARAMS, type AppSettings } from '../../types'
import { logger, serializeError } from '../shared/logger'
import type { WorkflowGenerateFn } from './engine'
import {
  WORKFLOW_GRAPH_VERSION,
  type GenerateNode,
  type InputNode,
  type OutputNode,
  type WorkflowGraph,
  type WorkflowImage,
  type WorkflowNode,
} from './types'

// ============================================================================
// 工作流运行时:把引擎的 generate 回调接到现有 callImageApi(经 /api-proxy 出图),
// 以及画布图的 localStorage 持久化(只存结构,不存图片 dataURL 以免撑爆配额)。
// ============================================================================

function makeImageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `wf-${crypto.randomUUID()}`
  }
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 用当前 settings 构造引擎所需的出图实现。 */
export function makeGenerateFn(settings: AppSettings): WorkflowGenerateFn {
  return async ({ prompt, images, params, signal }) => {
    const result = await callImageApi({
      settings,
      prompt,
      params: {
        ...DEFAULT_PARAMS,
        size: params.size,
        quality: params.quality,
        n: params.n,
      },
      inputImageDataUrls: images.map((img) => img.dataUrl),
      signal,
      telemetry: { appMode: 'workflow', actionType: 'generate' },
    })
    return result.images.map<WorkflowImage>((dataUrl) => ({ id: makeImageId(), dataUrl }))
  }
}

// ---- 持久化(结构 only) ---------------------------------------------------

const STORAGE_KEY = 'picpilot.workflow.graph.v1'

/** 去掉所有图片 dataURL 与运行态,只保留可复用的工作流结构。供多工作流存储复用。 */
export function stripImages(node: WorkflowNode): WorkflowNode {
  const data = node.data
  if (data.kind === 'input') return { ...node, data: { ...data, images: [] } } as InputNode
  if (data.kind === 'generate') return { ...node, data: { ...data, outputs: [], status: 'idle', error: null, elapsedMs: null } } as GenerateNode
  if (data.kind === 'output') return { ...node, data: { ...data, images: [] } } as OutputNode
  return node
}

export function saveGraph(graph: WorkflowGraph): void {
  try {
    const lean: WorkflowGraph = {
      version: WORKFLOW_GRAPH_VERSION,
      nodes: graph.nodes.map(stripImages),
      edges: graph.edges,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lean))
  } catch (error) {
    logger.warn('system', '工作流持久化失败', { error: serializeError(error) })
  }
}

export function loadGraph(): WorkflowGraph | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WorkflowGraph>
    if (!parsed || parsed.version !== WORKFLOW_GRAPH_VERSION || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null
    }
    return { version: WORKFLOW_GRAPH_VERSION, nodes: parsed.nodes as WorkflowNode[], edges: parsed.edges }
  } catch (error) {
    logger.warn('system', '工作流读取失败', { error: serializeError(error) })
    return null
  }
}

export function clearSavedGraph(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

// ---- 导入 / 导出(借鉴 infinite-canvas 的画布导入导出) -----------------------

/** 导出当前工作流为 JSON 文件(含图片,便于完整备份与分享)。 */
export function exportGraphToFile(graph: WorkflowGraph): void {
  const data = JSON.stringify({ version: WORKFLOW_GRAPH_VERSION, nodes: graph.nodes, edges: graph.edges }, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `picpilot-workflow-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 解析导入的工作流 JSON;结构非法返回 null。 */
export function parseGraphFile(text: string): WorkflowGraph | null {
  try {
    const parsed = JSON.parse(text) as Partial<WorkflowGraph>
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return { version: WORKFLOW_GRAPH_VERSION, nodes: parsed.nodes as WorkflowNode[], edges: parsed.edges }
  } catch {
    return null
  }
}
