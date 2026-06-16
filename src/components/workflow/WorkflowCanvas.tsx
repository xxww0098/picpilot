import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  MiniMap,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type NodeMouseHandler,
  type OnConnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useStore } from '../../store'
import { openConfirmDialog, openDestructiveConfirm, openPromptDialog, showAppToast } from '../../lib/ui/dialog'
import { runWorkflow, validateGraph } from '../../lib/workflow/engine'
import { makeGenerateFn, exportGraphToFile, parseGraphFile } from '../../lib/workflow/runtime'
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  getActiveId,
  listWorkflows,
  loadWorkflowGraph,
  renameWorkflow,
  saveWorkflowGraph,
  setActiveId,
  type WorkflowMeta,
} from '../../lib/workflow/workflowStore'
import { VIRTUAL_TRY_ON_POSTER_TEMPLATE, WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../../lib/workflow/templates'
import { createNode, makeEdgeId, makeNodeId, type GenerateNode, type OutputNode, type WorkflowEdge, type WorkflowNode, type WorkflowNodeKind, NODE_META } from '../../lib/workflow/types'
import { workflowNodeTypes } from './nodes'
import { useUndoRedo } from './useUndoRedo'
import WorkflowSwitcher from './WorkflowSwitcher'
import WorkflowTemplateMenu from './WorkflowTemplateMenu'

const PALETTE: WorkflowNodeKind[] = ['input', 'text', 'generate', 'output']
const NODE_CONTEXT_MENU_WIDTH = 184
const NODE_CONTEXT_MENU_HEIGHT = 206
const NODE_DUPLICATE_OFFSET = 42
const ZOOM_MIN = 0.2
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

type NodeContextMenuState = {
  nodeId: string
  x: number
  y: number
}

type ClipboardGraph = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

function isTextEditingElement(el: Element | null) {
  return el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function cloneNodeData(data: WorkflowNode['data']): WorkflowNode['data'] {
  return JSON.parse(JSON.stringify(data)) as WorkflowNode['data']
}

function cloneGraph(graph: ClipboardGraph, offset: number): ClipboardGraph {
  const idMap = new Map<string, string>()
  const nodes = graph.nodes.map((node) => {
    const nextId = makeNodeId(node.data.kind)
    idMap.set(node.id, nextId)
    return {
      ...node,
      id: nextId,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      selected: true,
      dragging: false,
      data: cloneNodeData(node.data),
    } as WorkflowNode
  })
  const edges = graph.edges
    .map((edge) => {
      const source = idMap.get(edge.source)
      const target = idMap.get(edge.target)
      if (!source || !target) return null
      return {
        ...edge,
        id: makeEdgeId(source, target, edge.sourceHandle, edge.targetHandle),
        source,
        target,
        selected: false,
      } as WorkflowEdge
    })
    .filter((edge): edge is WorkflowEdge => edge !== null)
  return { nodes, edges }
}

function ToolbarButton({
  onClick,
  children,
  variant = 'default',
  disabled,
  title,
}: {
  onClick: () => void
  children: React.ReactNode
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  title?: string
}) {
  const base = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const styles =
    variant === 'primary'
      ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90'
      : variant === 'danger'
        ? 'border border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400'
        : 'border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]'
  return <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${base} ${styles}`}>{children}</button>
}

function IconButton({
  onClick,
  children,
  title,
  disabled,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  title: string
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400'
          : 'text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarMenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        danger
          ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400'
          : 'text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]'
      }`}
    >
      {children}
    </button>
  )
}

function WorkflowCanvasInner() {
  const settings = useStore((s) => s.settings)
  const [activeId, setActiveIdState] = useState<string>(() => getActiveId())
  const [workflows, setWorkflows] = useState<WorkflowMeta[]>(() => listWorkflows())
  const initial = useMemo(() => loadWorkflowGraph(getActiveId()), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>(initial?.nodes ?? [])
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowEdge>(initial?.edges ?? [])
  const [running, setRunning] = useState(false)
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false)
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null)
  const [clipboardCount, setClipboardCount] = useState(0)
  const { zoom } = useViewport()
  const { getNodes, getEdges, updateNodeData, screenToFlowPosition, fitView, setViewport, zoomIn, zoomOut, zoomTo } = useReactFlow<WorkflowNode, WorkflowEdge>()
  const { take, undo, redo, reset, canUndo, canRedo } = useUndoRedo()
  const abortRef = useRef<AbortController | null>(null)
  const addCountRef = useRef(0)
  const pasteCountRef = useRef(0)
  const clipboardRef = useRef<ClipboardGraph | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const nodeMenuRef = useRef<HTMLDivElement>(null)
  const templateMenuRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const nodeContextMenuRef = useRef<HTMLDivElement>(null)
  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes])
  const selectedNodeIds = useMemo(() => selectedNodes.map((node) => node.id), [selectedNodes])
  const selectedEdges = useMemo(() => edges.filter((edge) => edge.selected), [edges])
  const selectedCount = selectedNodes.length + selectedEdges.length

  // 自动持久化(结构 only)到当前工作流,300ms 防抖。
  useEffect(() => {
    const t = setTimeout(() => saveWorkflowGraph(activeId, { version: 1, nodes, edges }), 300)
    return () => clearTimeout(t)
  }, [activeId, nodes, edges])

  useEffect(() => {
    if (!nodeMenuOpen && !templateMenuOpen && !moreMenuOpen && !nodeContextMenu) return
    const close = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        nodeMenuRef.current?.contains(target) ||
        templateMenuRef.current?.contains(target) ||
        moreMenuRef.current?.contains(target) ||
        nodeContextMenuRef.current?.contains(target)
      ) return
      setNodeMenuOpen(false)
      setTemplateMenuOpen(false)
      setMoreMenuOpen(false)
      setNodeContextMenu(null)
    }
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setNodeMenuOpen(false)
      setTemplateMenuOpen(false)
      setMoreMenuOpen(false)
      setNodeContextMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [nodeMenuOpen, templateMenuOpen, moreMenuOpen, nodeContextMenu])

  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      take()
      setEdges((eds) => addEdge({ ...conn, id: `e-${conn.source}.${conn.sourceHandle ?? ''}-${conn.target}.${conn.targetHandle ?? ''}` }, eds))
    },
    [setEdges, take],
  )

  const addNode = useCallback(
    (kind: WorkflowNodeKind) => {
      const n = addCountRef.current++
      // 在视口中心附近级联放置
      let position = { x: 160 + (n % 5) * 36, y: 120 + (n % 5) * 36 }
      try {
        position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        position = { x: position.x + (n % 4) * 28, y: position.y + (n % 4) * 28 }
      } catch {
        /* screenToFlowPosition 在极少数初始化竞态下可能不可用,用默认位置兜底 */
      }
      take()
      setNodes((nds) => [...nds, createNode(kind, position)])
    },
    [screenToFlowPosition, setNodes, take],
  )

  const openNodeContextMenu = useCallback<NodeMouseHandler<WorkflowNode>>(
    (event, node) => {
      event.preventDefault()
      event.stopPropagation()
      setNodeMenuOpen(false)
      setTemplateMenuOpen(false)
      setMoreMenuOpen(false)
      setNodes((nds) => nds.map((nd) => ({ ...nd, selected: nd.id === node.id })))
      setNodeContextMenu({
        nodeId: node.id,
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - NODE_CONTEXT_MENU_WIDTH - 8)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - NODE_CONTEXT_MENU_HEIGHT - 8)),
      })
    },
    [setNodes],
  )

  const getSelectedGraph = useCallback(
    (nodeIds?: string[]): ClipboardGraph | null => {
      const allNodes = getNodes()
      const allEdges = getEdges()
      const selectedIds = new Set(nodeIds ?? allNodes.filter((node) => node.selected).map((node) => node.id))
      if (selectedIds.size === 0) return null
      const graphNodes = allNodes.filter((node) => selectedIds.has(node.id))
      if (graphNodes.length === 0) return null
      const graphEdges = allEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      return { nodes: graphNodes, edges: graphEdges }
    },
    [getNodes, getEdges],
  )

  const deleteElementsById = useCallback(
    (nodeIds: string[] = [], edgeIds: string[] = []) => {
      const nodeSet = new Set(nodeIds)
      const edgeSet = new Set(edgeIds)
      if (nodeSet.size === 0 && edgeSet.size === 0) return
      if (running) {
        showAppToast('工作流运行中，暂不能删除画布元素。', 'info')
        setNodeContextMenu(null)
        return
      }
      take()
      setNodes((nds) => nds.filter((node) => !nodeSet.has(node.id)))
      setEdges((eds) => eds.filter((edge) => !edgeSet.has(edge.id) && !nodeSet.has(edge.source) && !nodeSet.has(edge.target)))
      setNodeContextMenu(null)
    },
    [running, setNodes, setEdges, take],
  )

  const deleteNodeById = useCallback((nodeId: string) => deleteElementsById([nodeId]), [deleteElementsById])

  const deleteSelection = useCallback(() => {
    const nodeIds = getNodes().filter((node) => node.selected).map((node) => node.id)
    const edgeIds = getEdges().filter((edge) => edge.selected).map((edge) => edge.id)
    if (nodeIds.length === 0 && edgeIds.length === 0) return
    deleteElementsById(nodeIds, edgeIds)
  }, [getNodes, getEdges, deleteElementsById])

  const copySelection = useCallback(
    (nodeIds?: string[]) => {
      const graph = getSelectedGraph(nodeIds)
      if (!graph) {
        showAppToast('请先选中要复制的节点。', 'info')
        return
      }
      clipboardRef.current = {
        nodes: graph.nodes.map((node) => ({ ...node, data: cloneNodeData(node.data) } as WorkflowNode)),
        edges: graph.edges.map((edge) => ({ ...edge })),
      }
      pasteCountRef.current = 0
      setClipboardCount(graph.nodes.length)
      showAppToast(`已复制 ${graph.nodes.length} 个节点`, 'success')
      setNodeContextMenu(null)
    },
    [getSelectedGraph],
  )

  const addClonedGraph = useCallback(
    (graph: ClipboardGraph, offset = NODE_DUPLICATE_OFFSET) => {
      if (running) {
        showAppToast('工作流运行中，暂不能复制节点。', 'info')
        setNodeContextMenu(null)
        return
      }
      const cloned = cloneGraph(graph, offset)
      take()
      setNodes((nds) => [...nds.map((node) => ({ ...node, selected: false })), ...cloned.nodes])
      setEdges((eds) => [...eds.map((edge) => ({ ...edge, selected: false })), ...cloned.edges])
      setNodeContextMenu(null)
      setTimeout(() => fitView({ nodes: cloned.nodes.map((node) => ({ id: node.id })), padding: 0.24, duration: 220, maxZoom: 1.2 }), 30)
    },
    [running, setNodes, setEdges, take, fitView],
  )

  const duplicateSelection = useCallback(
    (nodeIds?: string[]) => {
      const graph = getSelectedGraph(nodeIds)
      if (!graph) {
        showAppToast('请先选中要复制的节点。', 'info')
        return
      }
      addClonedGraph(graph)
    },
    [getSelectedGraph, addClonedGraph],
  )

  const pasteClipboard = useCallback(() => {
    const graph = clipboardRef.current
    if (!graph) {
      showAppToast('剪贴板中没有节点。', 'info')
      return
    }
    pasteCountRef.current += 1
    addClonedGraph(graph, NODE_DUPLICATE_OFFSET + pasteCountRef.current * 18)
  }, [addClonedGraph])

  const focusNodesById = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length === 0) return
      setNodeContextMenu(null)
      void fitView({ nodes: nodeIds.map((id) => ({ id })), padding: 0.24, duration: 220, maxZoom: 1.25 })
    },
    [fitView],
  )

  const resetViewport = useCallback(() => {
    const currentNodes = getNodes()
    if (currentNodes.length > 0) {
      void fitView({ padding: 0.2, duration: 220 })
      return
    }
    void setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 220 })
  }, [getNodes, fitView, setViewport])

  // 键盘:画布级撤销/重做、复制/粘贴、副本、删除、重置视图。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEditingElement(document.activeElement)) return
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey

      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'c') {
        e.preventDefault()
        copySelection()
        return
      }
      if (mod && key === 'v') {
        e.preventDefault()
        pasteClipboard()
        return
      }
      if (mod && key === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (mod && key === '0') {
        e.preventDefault()
        resetViewport()
        return
      }
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        deleteSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, copySelection, pasteClipboard, duplicateSelection, resetViewport, deleteSelection])

  const loadTemplate = useCallback((template: WorkflowTemplate) => {
    const apply = () => {
      take()
      const g = template.build()
      setNodes(g.nodes)
      setEdges(g.edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
    }
    setTemplateMenuOpen(false)
    if (getNodes().length === 0) apply()
    else openConfirmDialog({ title: '加载模板', message: `将替换当前画布内容,确定加载「${template.name}」模板?`, onConfirm: apply })
  }, [getNodes, setNodes, setEdges, fitView, take])

  const clearCanvas = useCallback(() => {
    openDestructiveConfirm({
      title: '清空画布',
      message: '将移除当前工作流的所有节点与连线(可用「撤销」或 ⌘/Ctrl+Z 恢复)。',
      confirmText: '清空',
      onConfirm: () => {
        take()
        setNodes([])
        setEdges([])
      },
    })
  }, [setNodes, setEdges, take])

  // ---- 多工作流:切换 / 新建 / 重命名 / 复制 / 删除 ----
  const persistCurrent = useCallback(() => {
    saveWorkflowGraph(activeId, { version: 1, nodes: getNodes(), edges: getEdges() })
  }, [activeId, getNodes, getEdges])

  const loadInto = useCallback(
    (id: string) => {
      const g = loadWorkflowGraph(id)
      setNodes(g?.nodes ?? [])
      setEdges(g?.edges ?? [])
      setActiveIdState(id)
      setWorkflows(listWorkflows())
      reset() // 切换工作流后清空撤销历史,避免跨工作流误撤销
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
    },
    [setNodes, setEdges, reset, fitView],
  )

  const switchTo = useCallback(
    (id: string) => {
      if (id === activeId) return
      persistCurrent()
      setActiveId(id)
      loadInto(id)
    },
    [activeId, persistCurrent, loadInto],
  )

  const newWorkflow = useCallback(() => {
    openPromptDialog({
      title: '新建工作流',
      placeholder: '工作流名称(可留空)',
      onConfirm: (name: string) => {
        persistCurrent()
        const meta = createWorkflow(name)
        loadInto(meta.id)
      },
    })
  }, [persistCurrent, loadInto])

  const renameActive = useCallback(() => {
    const cur = workflows.find((w) => w.id === activeId)
    openPromptDialog({
      title: '重命名工作流',
      defaultValue: cur?.name ?? '',
      validate: (v: string) => (v.trim() ? null : '名称不能为空'),
      onConfirm: (name: string) => {
        renameWorkflow(activeId, name)
        setWorkflows(listWorkflows())
      },
    })
  }, [activeId, workflows])

  const duplicateActive = useCallback(() => {
    persistCurrent()
    const meta = duplicateWorkflow(activeId)
    loadInto(meta.id)
    showAppToast('已复制为新工作流', 'success')
  }, [activeId, persistCurrent, loadInto])

  const deleteActive = useCallback(() => {
    const cur = workflows.find((w) => w.id === activeId)
    openDestructiveConfirm({
      title: '删除工作流',
      message: `确定删除「${cur?.name ?? '工作流'}」?其节点与连线将一并删除。`,
      confirmText: '删除',
      onConfirm: () => {
        const nextId = deleteWorkflow(activeId)
        loadInto(nextId)
      },
    })
  }, [activeId, workflows, loadInto])

  const handleExport = useCallback(() => {
    if (getNodes().length === 0) {
      showAppToast('画布为空,无可导出内容', 'info')
      return
    }
    exportGraphToFile({ version: 1, nodes: getNodes(), edges: getEdges() })
  }, [getNodes, getEdges])

  const handleImportFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return
      const graph = parseGraphFile(await file.text())
      if (!graph) {
        showAppToast('导入失败:文件不是有效的工作流 JSON', 'error')
        return
      }
      take()
      setNodes(graph.nodes)
      setEdges(graph.edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
      showAppToast(`已导入 ${graph.nodes.length} 个节点`, 'success')
    },
    [setNodes, setEdges, fitView, take],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])

  const run = useCallback(async () => {
    const curNodes = getNodes()
    const curEdges = getEdges()
    const engineNodes = curNodes.map((nd) => ({ id: nd.id, data: nd.data }))
    const engineEdges = curEdges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }))

    const problems = validateGraph(engineNodes, engineEdges)
    if (problems.length > 0) {
      showAppToast(problems[0], 'error')
      return
    }

    // 重置运行态
    setNodes((nds) =>
      nds.map((nd) => {
        const data = nd.data
        if (data.kind === 'generate') return { ...nd, data: { ...data, status: 'idle', error: null, outputs: [], elapsedMs: null } } as GenerateNode
        if (data.kind === 'output') return { ...nd, data: { ...data, images: [] } } as OutputNode
        return nd
      }),
    )

    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    try {
      const result = await runWorkflow(engineNodes, engineEdges, makeGenerateFn(settings), {
        signal: controller.signal,
        onNodeUpdate: (nodeId, patch) => updateNodeData(nodeId, patch),
      })
      if (result.status === 'done') showAppToast('工作流运行完成', 'success')
      else if (result.status === 'canceled') showAppToast('已停止运行', 'info')
      else showAppToast('工作流运行失败,请查看红色节点', 'error')
    } catch (error) {
      showAppToast(error instanceof Error ? error.message : '工作流运行出错', 'error')
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [getNodes, getEdges, setNodes, updateNodeData, settings])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeContextMenu={openNodeContextMenu}
      onPaneClick={() => setNodeContextMenu(null)}
      onPaneContextMenu={(event) => {
        event.preventDefault()
        setNodeContextMenu(null)
      }}
      onNodeDragStart={() => take()}
      onBeforeDelete={async () => {
        take()
        return true
      }}
      nodeTypes={workflowNodeTypes}
      colorMode="system"
      className="bg-[hsl(var(--muted))]"
      fitView
      minZoom={ZOOM_MIN}
      maxZoom={ZOOM_MAX}
      deleteKeyCode={null}
      selectionOnDrag
      defaultEdgeOptions={{ animated: true, style: { strokeWidth: 2 } }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Lines} gap={32} size={1} color="hsl(var(--border))" bgColor="hsl(var(--muted))" />
      <MiniMap
        pannable
        zoomable
        position="bottom-left"
        className="!m-4 !h-28 !w-40 overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-sm"
        nodeStrokeWidth={2}
        nodeBorderRadius={8}
        bgColor="hsl(var(--background))"
        maskColor="hsl(var(--muted))"
        nodeColor={(node) => {
          if (node.type === 'input') return '#0ea5e9'
          if (node.type === 'text') return '#8b5cf6'
          if (node.type === 'generate') return '#f59e0b'
          return '#10b981'
        }}
      />

      {selectedNodeIds.length > 0 && (
        <NodeToolbar nodeId={selectedNodeIds} position={Position.Top} offset={14} align="center" isVisible className="nodrag nopan">
          <div className="flex items-center gap-1 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 p-1 shadow-lg backdrop-blur">
            <IconButton title="聚焦选中节点" onClick={() => focusNodesById(selectedNodeIds)}>⌖</IconButton>
            <IconButton title="复制选中节点" onClick={() => copySelection(selectedNodeIds)}>⧉</IconButton>
            <IconButton title="创建副本" onClick={() => duplicateSelection(selectedNodeIds)} disabled={running}>＋</IconButton>
            <span className="mx-1 h-5 w-px bg-[hsl(var(--border))]" />
            <IconButton title="删除选中节点" onClick={deleteSelection} danger disabled={running}>⌫</IconButton>
          </div>
        </NodeToolbar>
      )}

      <Panel position="top-left" className="!m-3">
        <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 p-2 shadow-sm backdrop-blur">
          <WorkflowSwitcher
            workflows={workflows}
            activeId={activeId}
            disabled={running}
            onSwitch={switchTo}
            onNew={newWorkflow}
            onRename={renameActive}
            onDuplicate={duplicateActive}
            onDelete={deleteActive}
          />
          <div className="hidden items-center gap-2 text-[11px] text-[hsl(var(--muted-foreground))] sm:flex">
            <span>{nodes.length} 节点</span>
            <span className="h-1 w-1 rounded-full bg-[hsl(var(--border))]" />
            <span>{edges.length} 连线</span>
            {selectedCount > 0 && (
              <>
                <span className="h-1 w-1 rounded-full bg-[hsl(var(--border))]" />
                <span className="text-[hsl(var(--foreground))]">{selectedCount} 已选</span>
              </>
            )}
          </div>
        </div>
      </Panel>

      <Panel position="bottom-center" className="!mb-4">
        <div className="nodrag nopan flex flex-wrap items-center justify-center gap-1 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 p-1.5 shadow-lg backdrop-blur">
          {running ? (
            <ToolbarButton variant="danger" onClick={stop} title="停止运行">■ 停止</ToolbarButton>
          ) : (
            <ToolbarButton variant="primary" onClick={() => void run()} title="运行工作流">▶ 运行</ToolbarButton>
          )}
          <span className="mx-1 h-6 w-px bg-[hsl(var(--border))]" />
          <IconButton title="撤销 (Ctrl/⌘+Z)" onClick={undo} disabled={!canUndo || running}>↶</IconButton>
          <IconButton title="重做 (Ctrl/⌘+Shift+Z)" onClick={redo} disabled={!canRedo || running}>↷</IconButton>
          <IconButton title="粘贴节点 (Ctrl/⌘+V)" onClick={pasteClipboard} disabled={clipboardCount === 0 || running}>⎘</IconButton>
          <span className="mx-1 h-6 w-px bg-[hsl(var(--border))]" />
          <div ref={nodeMenuRef} className="relative">
            <ToolbarButton
              onClick={() => {
                setTemplateMenuOpen(false)
                setMoreMenuOpen(false)
                setNodeContextMenu(null)
                setNodeMenuOpen((open) => !open)
              }}
              disabled={running}
              title="添加节点"
            >
              + 添加节点
            </ToolbarButton>
            {nodeMenuOpen && (
              <div
                role="menu"
                className="animate-dropdown-down absolute bottom-full left-0 z-20 mb-2 w-56 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 shadow-lg"
              >
                {PALETTE.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNodeMenuOpen(false)
                      addNode(kind)
                    }}
                    className="flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-[hsl(var(--muted))]"
                  >
                    <span className="text-sm font-medium text-[hsl(var(--foreground))]">{NODE_META[kind].title}</span>
                    <span className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">{NODE_META[kind].description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div ref={templateMenuRef} className="relative">
            <ToolbarButton
              onClick={() => {
                setNodeMenuOpen(false)
                setMoreMenuOpen(false)
                setNodeContextMenu(null)
                setTemplateMenuOpen((open) => !open)
              }}
              disabled={running}
              title="选择工作流模板"
            >
              模板
            </ToolbarButton>
            {templateMenuOpen && (
              <WorkflowTemplateMenu templates={WORKFLOW_TEMPLATES} onSelect={loadTemplate} />
            )}
          </div>
          <div ref={moreMenuRef} className="relative">
            <ToolbarButton
              onClick={() => {
                setNodeMenuOpen(false)
                setTemplateMenuOpen(false)
                setNodeContextMenu(null)
                setMoreMenuOpen((open) => !open)
              }}
              disabled={running}
              title="更多画布操作"
            >
              更多
            </ToolbarButton>
            {moreMenuOpen && (
              <div
                role="menu"
                className="animate-dropdown-down absolute bottom-full right-0 z-20 mb-2 w-40 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 shadow-lg"
              >
                <ToolbarMenuItem onClick={() => { setMoreMenuOpen(false); handleExport() }}>导出 JSON</ToolbarMenuItem>
                <ToolbarMenuItem onClick={() => { setMoreMenuOpen(false); fileInputRef.current?.click() }}>导入 JSON</ToolbarMenuItem>
                <ToolbarMenuItem danger onClick={() => { setMoreMenuOpen(false); clearCanvas() }}>清空画布</ToolbarMenuItem>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              void handleImportFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </Panel>

      <Panel position="bottom-right" className="!m-4">
        <div className="nodrag nopan flex items-center gap-1 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 p-1.5 shadow-lg backdrop-blur">
          <IconButton title="缩小" onClick={() => { void zoomOut({ duration: 120 }) }}>−</IconButton>
          <input
            aria-label="缩放"
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(zoom.toFixed(2))))}
            onChange={(event) => { void zoomTo(Number(event.currentTarget.value), { duration: 80 }) }}
            className="h-8 w-24 accent-[hsl(var(--primary))]"
          />
          <button
            type="button"
            onClick={() => { void zoomTo(1, { duration: 160 }) }}
            className="h-8 min-w-12 rounded-lg px-2 text-xs font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton title="放大" onClick={() => { void zoomIn({ duration: 120 }) }}>＋</IconButton>
          <span className="mx-1 h-6 w-px bg-[hsl(var(--border))]" />
          <ToolbarButton onClick={resetViewport} title="适合视图 (Ctrl/⌘+0)">适合视图</ToolbarButton>
        </div>
      </Panel>

      {nodes.length === 0 && (
        <Panel position="top-center" className="pointer-events-none !mt-32">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-6 text-center shadow-sm">
            <div className="mb-1 text-base font-semibold text-[hsl(var(--foreground))]">工作流画布</div>
            <p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">
              上传服装正视图和模特样貌参考,运行后生成竖版试衣海报。也可以从模板菜单选择其他工作流。
            </p>
            <ToolbarButton variant="primary" onClick={() => loadTemplate(VIRTUAL_TRY_ON_POSTER_TEMPLATE)}>虚拟试衣海报</ToolbarButton>
          </div>
        </Panel>
      )}

      {nodeContextMenu && (
        <div
          ref={nodeContextMenuRef}
          role="menu"
          className="nodrag nopan fixed z-30 w-48 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 shadow-lg"
          style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
        >
          <div className="truncate px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))]">
            {nodes.find((node) => node.id === nodeContextMenu.nodeId)?.data.label ?? '节点'}
          </div>
          <ToolbarMenuItem onClick={() => focusNodesById([nodeContextMenu.nodeId])}>
            聚焦节点
          </ToolbarMenuItem>
          <ToolbarMenuItem onClick={() => copySelection([nodeContextMenu.nodeId])}>
            复制节点
          </ToolbarMenuItem>
          <ToolbarMenuItem onClick={() => duplicateSelection([nodeContextMenu.nodeId])}>
            创建副本
          </ToolbarMenuItem>
          <ToolbarMenuItem
            danger
            onClick={() => deleteNodeById(nodeContextMenu.nodeId)}
          >
            删除节点
          </ToolbarMenuItem>
        </div>
      )}
    </ReactFlow>
  )
}

export default function WorkflowCanvas() {
  return (
    <div className="h-[calc(100vh-3.5rem)] w-full">
      <ReactFlowProvider>
        <WorkflowCanvasInner />
      </ReactFlowProvider>
    </div>
  )
}
