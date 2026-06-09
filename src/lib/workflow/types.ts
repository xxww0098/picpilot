import type { Edge, Node } from '@xyflow/react'

// ============================================================================
// 工作流数据模型
//
// 设计要点:
// - 节点 data 用 `type`(而非 interface)定义 —— React Flow v12 的 Node<T> 约束
//   `T extends Record<string, unknown>`,type 字面量满足该约束而 interface 不满足。
// - 以 `kind` 作判别式联合,既满足约束又能正常窄化。
// - 引擎(engine.ts)只依赖下方的结构化 EngineNode/EngineEdge,不依赖 React Flow,
//   保持纯函数、可单测。React Flow 的节点天然结构兼容 EngineNode。
// ============================================================================

/** 工作流中流转的图片:id 用于 IndexedDB / 去重,dataUrl 用于预览与作为下游输入。 */
export type WorkflowImage = {
  id: string
  dataUrl: string
}

/** 单节点运行状态。 */
export type NodeRunStatus = 'idle' | 'running' | 'done' | 'error'

/** 生成节点的出图参数(精简自 TaskParams,画布场景只暴露常用项)。 */
export type WorkflowGenerateParams = {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  n: number
}

export const DEFAULT_GENERATE_PARAMS: WorkflowGenerateParams = {
  size: 'auto',
  quality: 'auto',
  n: 1,
}

// ---- 各节点 data 形状(判别式联合) ----------------------------------------

export type InputNodeData = {
  kind: 'input'
  label: string
  /** 输入说明,用于模板化工作流指导用户上传哪类图片。 */
  description?: string
  /** 限制图片数量;单图模板设为 1 时,新上传会替换旧图。 */
  maxImages?: number
  /** 用户上传的产品图 / 参考图 */
  images: WorkflowImage[]
}

export type TextNodeData = {
  kind: 'text'
  label: string
  /** 提示词文本 */
  text: string
}

export type GenerateNodeData = {
  kind: 'generate'
  label: string
  /** 内联提示词;若 `prompt` 端口连了上游文本节点,则运行时优先用上游文本。 */
  prompt: string
  params: WorkflowGenerateParams
  // ---- 运行态(随执行更新,也随图持久化以便回看上次结果) ----
  status: NodeRunStatus
  error: string | null
  outputs: WorkflowImage[]
  elapsedMs: number | null
}

export type OutputNodeData = {
  kind: 'output'
  label: string
  /** 汇总自上游的图片 */
  images: WorkflowImage[]
}

export type WorkflowNodeData =
  | InputNodeData
  | TextNodeData
  | GenerateNodeData
  | OutputNodeData

export type WorkflowNodeKind = WorkflowNodeData['kind']

// ---- React Flow 节点 / 边类型别名 ------------------------------------------

export type InputNode = Node<InputNodeData, 'input'>
export type TextNode = Node<TextNodeData, 'text'>
export type GenerateNode = Node<GenerateNodeData, 'generate'>
export type OutputNode = Node<OutputNodeData, 'output'>
export type WorkflowNode = InputNode | TextNode | GenerateNode | OutputNode
export type WorkflowEdge = Edge

// ---- 端口(handle)id 约定 -------------------------------------------------
//
// generate 节点有两个输入端口(images / prompt)和一个输出端口(out)。
// input / text 各有一个输出端口(out)。output 有一个输入端口(in)。

export const HANDLE = {
  /** 通用输出端口(input / text / generate) */
  OUT: 'out',
  /** generate 的图片输入端口 */
  GEN_IMAGES: 'images',
  /** generate 的提示词输入端口 */
  GEN_PROMPT: 'prompt',
  /** output 的输入端口 */
  IN: 'in',
} as const

// ---- 引擎用结构化类型(与 React Flow 解耦,便于纯函数单测) ------------------

export type EngineNode = {
  id: string
  data: WorkflowNodeData
}

export type EngineEdge = {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

/** 端口上流转的值:图片数组(图片端口)或字符串(提示词端口)。 */
export type PortValue = WorkflowImage[] | string | undefined

// ---- 可序列化工作流图(持久化 + 模板定义) --------------------------------

export const WORKFLOW_GRAPH_VERSION = 1

export type WorkflowGraph = {
  version: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

// ---- 节点工厂 --------------------------------------------------------------

let nodeSeq = 0

/** 生成画布内唯一节点 id(非持久化敏感,简单自增 + 随机后缀即可)。 */
export function makeNodeId(kind: WorkflowNodeKind): string {
  nodeSeq += 1
  return `${kind}-${Date.now().toString(36)}-${nodeSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function makeEdgeId(source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null): string {
  return `e-${source}.${sourceHandle ?? HANDLE.OUT}-${target}.${targetHandle ?? HANDLE.IN}`
}

export function createInputNode(
  position: { x: number; y: number },
  label = '输入图片',
  options: { description?: string; maxImages?: number } = {},
): InputNode {
  return {
    id: makeNodeId('input'),
    type: 'input',
    position,
    data: { kind: 'input', label, description: options.description, maxImages: options.maxImages, images: [] },
  }
}

export function createTextNode(position: { x: number; y: number }, label = '提示词', text = ''): TextNode {
  return {
    id: makeNodeId('text'),
    type: 'text',
    position,
    data: { kind: 'text', label, text },
  }
}

export function createGenerateNode(
  position: { x: number; y: number },
  label = '生成图片',
  prompt = '',
  params: WorkflowGenerateParams = DEFAULT_GENERATE_PARAMS,
): GenerateNode {
  return {
    id: makeNodeId('generate'),
    type: 'generate',
    position,
    data: {
      kind: 'generate',
      label,
      prompt,
      params: { ...params },
      status: 'idle',
      error: null,
      outputs: [],
      elapsedMs: null,
    },
  }
}

export function createOutputNode(position: { x: number; y: number }, label = '输出'): OutputNode {
  return {
    id: makeNodeId('output'),
    type: 'output',
    position,
    data: { kind: 'output', label, images: [] },
  }
}

/** 新建节点的统一入口(供画布「添加节点」面板使用)。 */
export function createNode(kind: WorkflowNodeKind, position: { x: number; y: number }): WorkflowNode {
  switch (kind) {
    case 'input':
      return createInputNode(position)
    case 'text':
      return createTextNode(position)
    case 'generate':
      return createGenerateNode(position)
    case 'output':
      return createOutputNode(position)
  }
}

/** 节点元信息:面板展示用的中文名与简介。 */
export const NODE_META: Record<WorkflowNodeKind, { title: string; description: string }> = {
  input: { title: '输入图片', description: '上传产品图 / 参考图,作为下游生成的输入。' },
  text: { title: '提示词', description: '编写一段提示词,连到生成节点的提示词端口。' },
  generate: { title: '生成图片', description: '汇总输入图片 + 提示词,调用出图接口生成结果。' },
  output: { title: '输出', description: '汇总上游生成结果,预览与下载。' },
}
