import {
  HANDLE,
  type EngineEdge,
  type EngineNode,
  type NodeRunStatus,
  type WorkflowGenerateParams,
  type WorkflowImage,
} from './types'

// ============================================================================
// 工作流执行引擎(纯逻辑,不依赖 React / React Flow,可单测)
//
// 数据流语义:
//   input    → 输出 WorkflowImage[](data.images)
//   text     → 输出 string(data.text)
//   generate → 汇总 images 端口的图片 + prompt 端口/内联提示词,调用注入的
//              generate 回调,输出 WorkflowImage[]
//   output   → 汇总上游图片,仅作展示(无输出)
//
// 失败传播:某 generate 失败后,依赖其图片的下游 generate 直接跳过(标记 error);
//          output 节点仍尽力汇总已成功的上游结果(部分成功)。
// ============================================================================

/** 注入的出图实现:真实环境包装 callImageApi,测试注入假实现。 */
export type WorkflowGenerateFn = (input: {
  nodeId: string
  prompt: string
  images: WorkflowImage[]
  params: WorkflowGenerateParams
  signal?: AbortSignal
}) => Promise<WorkflowImage[]>

/** 运行过程中对单个节点 data 的增量更新(UI 据此 patch 节点)。 */
export type WorkflowNodePatch = {
  status?: NodeRunStatus
  error?: string | null
  /** generate 节点产物 */
  outputs?: WorkflowImage[]
  /** output 节点汇总结果 */
  images?: WorkflowImage[]
  elapsedMs?: number | null
}

export type RunCallbacks = {
  onNodeUpdate?: (nodeId: string, patch: WorkflowNodePatch) => void
  signal?: AbortSignal
  /** 同时执行的 generate 节点上限(默认 4)。独立分区会并行,提速。 */
  concurrency?: number
}

export type RunResult = {
  status: 'done' | 'error' | 'canceled'
  nodeStatus: Record<string, NodeRunStatus>
  errors: Record<string, string>
  /** 每个节点的最终输出值(input/generate=图片,text=字符串,output=汇总图片)。 */
  nodeOutputs: Record<string, WorkflowImage[] | string | undefined>
}

// ---- 拓扑排序 + 环检测(Kahn) ---------------------------------------------

export type TopoResult =
  | { ok: true; order: string[] }
  | { ok: false; cycleNodeIds: string[] }

export function topologicalOrder(nodes: EngineNode[], edges: EngineEdge[]): TopoResult {
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const indegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    adj.set(id, [])
  }
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue
    adj.get(e.source)?.push(e.target)
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  }
  // 稳定起点:按原始顺序入队入度为 0 的节点。
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()
    if (id === undefined) break
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (order.length !== ids.length) {
    const cycleNodeIds = ids.filter((id) => (indegree.get(id) ?? 0) > 0)
    return { ok: false, cycleNodeIds }
  }
  return { ok: true, order }
}

// ---- 图校验(UI 运行前提示 + 单测) ----------------------------------------

export function getIncomingEdges(nodeId: string, edges: EngineEdge[]): EngineEdge[] {
  return edges.filter((e) => e.target === nodeId)
}

/** 返回人类可读的问题列表;为空表示可运行。 */
export function validateGraph(nodes: EngineNode[], edges: EngineEdge[]): string[] {
  const problems: string[] = []
  const topo = topologicalOrder(nodes, edges)
  if (!topo.ok) problems.push('工作流存在环,无法执行。请移除形成回路的连线。')

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const generateNodes = nodes.filter((n) => n.data.kind === 'generate')
  if (generateNodes.length === 0) problems.push('至少需要一个「生成图片」节点。')

  for (const n of generateNodes) {
    if (n.data.kind !== 'generate') continue
    const incoming = getIncomingEdges(n.id, edges)
    const hasPromptEdge = incoming.some((e) => (e.targetHandle ?? '') === HANDLE.GEN_PROMPT)
    const hasImageEdge = incoming.some((e) => (e.targetHandle ?? '') !== HANDLE.GEN_PROMPT)
    const inlinePrompt = n.data.prompt.trim()
    if (!hasPromptEdge && !inlinePrompt && !hasImageEdge) {
      problems.push(`生成节点「${n.data.label}」缺少提示词与输入图片。`)
    }
    // 提示词端口必须连文本节点
    for (const e of incoming) {
      if ((e.targetHandle ?? '') !== HANDLE.GEN_PROMPT) continue
      const src = byId.get(e.source)
      if (src && src.data.kind !== 'text') {
        problems.push(`生成节点「${n.data.label}」的提示词端口只能连「提示词」节点。`)
      }
    }
  }
  return problems
}

// ---- 输入汇总 --------------------------------------------------------------

function gatherImages(
  nodeId: string,
  edges: EngineEdge[],
  nodeOutput: Map<string, WorkflowImage[] | string>,
  opts: { promptHandle?: string } = {},
): WorkflowImage[] {
  const images: WorkflowImage[] = []
  for (const e of getIncomingEdges(nodeId, edges)) {
    // prompt 端口不计入图片
    if (opts.promptHandle && (e.targetHandle ?? '') === opts.promptHandle) continue
    const v = nodeOutput.get(e.source)
    if (Array.isArray(v)) images.push(...v)
  }
  // 去重(同一张图被多路径汇入时)
  const seen = new Set<string>()
  return images.filter((img) => (seen.has(img.id) ? false : (seen.add(img.id), true)))
}

function gatherPrompt(nodeId: string, edges: EngineEdge[], nodeOutput: Map<string, WorkflowImage[] | string>): string | undefined {
  for (const e of getIncomingEdges(nodeId, edges)) {
    if ((e.targetHandle ?? '') !== HANDLE.GEN_PROMPT) continue
    const v = nodeOutput.get(e.source)
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

// ---- 执行 ------------------------------------------------------------------

export async function runWorkflow(
  nodes: EngineNode[],
  edges: EngineEdge[],
  generate: WorkflowGenerateFn,
  cb: RunCallbacks = {},
): Promise<RunResult> {
  const nodeStatus: Record<string, NodeRunStatus> = {}
  const errors: Record<string, string> = {}
  const nodeOutput = new Map<string, WorkflowImage[] | string>()
  for (const n of nodes) nodeStatus[n.id] = 'idle'

  const topo = topologicalOrder(nodes, edges)
  if (!topo.ok) {
    for (const id of topo.cycleNodeIds) {
      nodeStatus[id] = 'error'
      errors[id] = '存在环'
      cb.onNodeUpdate?.(id, { status: 'error', error: '工作流存在环,无法执行' })
    }
    return { status: 'error', nodeStatus, errors, nodeOutputs: collect(nodeOutput) }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const failed = new Set<string>()
  const concurrency = Math.max(1, Math.floor(cb.concurrency ?? 4))

  // 依赖图(按「不同的上游节点数」计 indegree:某上游完成即满足它发出的所有边)。
  const idSet = new Set(topo.order)
  const upstream = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const id of topo.order) {
    upstream.set(id, new Set())
    dependents.set(id, new Set())
  }
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue
    upstream.get(e.target)?.add(e.source)
    dependents.get(e.source)?.add(e.target)
  }
  const remaining = new Map<string, number>()
  for (const id of topo.order) remaining.set(id, upstream.get(id)?.size ?? 0)

  const aborted = () => cb.signal?.aborted === true

  async function processNode(id: string): Promise<void> {
    const node = byId.get(id)
    if (!node) return
    const data = node.data

    if (data.kind === 'input') {
      nodeOutput.set(id, data.images)
      nodeStatus[id] = 'done'
      return
    }
    if (data.kind === 'text') {
      nodeOutput.set(id, data.text)
      nodeStatus[id] = 'done'
      return
    }
    if (data.kind === 'output') {
      const images = gatherImages(id, edges, nodeOutput)
      nodeOutput.set(id, images)
      nodeStatus[id] = 'done'
      cb.onNodeUpdate?.(id, { status: 'done', images })
      return
    }

    // generate
    const hasFailedUpstream = [...(upstream.get(id) ?? [])].some((u) => failed.has(u))
    if (hasFailedUpstream) {
      failed.add(id)
      nodeStatus[id] = 'error'
      errors[id] = '上游节点失败,已跳过'
      cb.onNodeUpdate?.(id, { status: 'error', error: '上游节点失败,已跳过', outputs: [] })
      return
    }
    const images = gatherImages(id, edges, nodeOutput, { promptHandle: HANDLE.GEN_PROMPT })
    const prompt = gatherPrompt(id, edges, nodeOutput) ?? data.prompt
    if (!prompt.trim() && images.length === 0) {
      failed.add(id)
      nodeStatus[id] = 'error'
      errors[id] = '缺少提示词与输入图片'
      cb.onNodeUpdate?.(id, { status: 'error', error: '缺少提示词与输入图片', outputs: [] })
      return
    }
    if (aborted()) return
    nodeStatus[id] = 'running'
    cb.onNodeUpdate?.(id, { status: 'running', error: null })
    const startedAt = Date.now()
    try {
      const outputs = await generate({ nodeId: id, prompt, images, params: data.params, signal: cb.signal })
      if (aborted()) {
        nodeStatus[id] = 'idle'
        return
      }
      nodeOutput.set(id, outputs)
      nodeStatus[id] = 'done'
      cb.onNodeUpdate?.(id, { status: 'done', outputs, elapsedMs: Date.now() - startedAt, error: null })
    } catch (err) {
      if (aborted()) {
        nodeStatus[id] = 'idle'
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      failed.add(id)
      nodeStatus[id] = 'error'
      errors[id] = message
      cb.onNodeUpdate?.(id, { status: 'error', error: message, elapsedMs: Date.now() - startedAt, outputs: [] })
    }
  }

  // 并发 DAG 调度:就绪即调度,受 concurrency 上限约束。
  const total = topo.order.length
  return await new Promise<RunResult>((resolve) => {
    const ready: string[] = topo.order.filter((id) => (remaining.get(id) ?? 0) === 0)
    let active = 0
    let done = 0
    let settled = false

    const settle = () => {
      if (settled) return
      settled = true
      const status = aborted() ? 'canceled' : Object.keys(errors).length > 0 ? 'error' : 'done'
      resolve({ status, nodeStatus, errors, nodeOutputs: collect(nodeOutput) })
    }

    const onComplete = (id: string) => {
      active -= 1
      done += 1
      for (const d of dependents.get(id) ?? []) {
        const r = (remaining.get(d) ?? 1) - 1
        remaining.set(d, r)
        if (r === 0) ready.push(d)
      }
      pump()
    }

    function pump() {
      if (settled) return
      if (aborted()) {
        if (active === 0) settle()
        return
      }
      if (done === total && active === 0) {
        settle()
        return
      }
      while (ready.length > 0 && active < concurrency) {
        const id = ready.shift()
        if (id === undefined) break
        active += 1
        void processNode(id).then(() => onComplete(id))
      }
    }

    if (total === 0) {
      settle()
      return
    }
    pump()
  })
}

function collect(nodeOutput: Map<string, WorkflowImage[] | string>): RunResult['nodeOutputs'] {
  const out: RunResult['nodeOutputs'] = {}
  for (const [k, v] of nodeOutput) out[k] = v
  return out
}
