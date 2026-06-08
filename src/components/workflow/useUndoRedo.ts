import { useCallback, useReducer, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { WorkflowEdge, WorkflowNode } from '../../lib/workflow/types'

// 画布撤销/重做(借鉴 infinite-canvas 的画布历史)。
// 采用「动作前快照」策略:在结构性变更(增删节点/连线、拖动、加载模板、清空、导入)前
// 调用 take() 入栈,比逐帧自动快照更省、更可控。文本编辑走原生 textarea 撤销,不入栈。

type Snapshot = { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
const MAX_HISTORY = 100

export function useUndoRedo() {
  const { getNodes, getEdges, setNodes, setEdges } = useReactFlow<WorkflowNode, WorkflowEdge>()
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const [, force] = useReducer((x: number) => x + 1, 0)

  const take = useCallback(() => {
    past.current.push({ nodes: getNodes(), edges: getEdges() })
    if (past.current.length > MAX_HISTORY) past.current.shift()
    future.current = []
    force()
  }, [getNodes, getEdges])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push({ nodes: getNodes(), edges: getEdges() })
    setNodes(prev.nodes)
    setEdges(prev.edges)
    force()
  }, [getNodes, getEdges, setNodes, setEdges])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push({ nodes: getNodes(), edges: getEdges() })
    setNodes(next.nodes)
    setEdges(next.edges)
    force()
  }, [getNodes, getEdges, setNodes, setEdges])

  // 清空历史(切换工作流等上下文切换时调用,避免跨工作流误撤销)。
  const reset = useCallback(() => {
    past.current = []
    future.current = []
    force()
  }, [])

  return { take, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 }
}
