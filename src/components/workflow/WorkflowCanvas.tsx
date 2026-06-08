import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type OnConnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useStore } from '../../store'
import { openConfirmDialog, openDestructiveConfirm, openPromptDialog, showAppToast } from '../../lib/dialog'
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
import { ECOMMERCE_DETAIL_TEMPLATE } from '../../lib/workflow/templates'
import { createNode, type GenerateNode, type OutputNode, type WorkflowEdge, type WorkflowNode, type WorkflowNodeKind, NODE_META } from '../../lib/workflow/types'
import { workflowNodeTypes } from './nodes'
import { useUndoRedo } from './useUndoRedo'
import WorkflowSwitcher from './WorkflowSwitcher'

const PALETTE: WorkflowNodeKind[] = ['input', 'text', 'generate', 'output']

function ToolbarButton({
  onClick,
  children,
  variant = 'default',
  disabled,
}: {
  onClick: () => void
  children: React.ReactNode
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
}) {
  const base = 'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const styles =
    variant === 'primary'
      ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90'
      : variant === 'danger'
        ? 'border border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400'
        : 'border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
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
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const { getNodes, getEdges, updateNodeData, screenToFlowPosition, fitView } = useReactFlow<WorkflowNode, WorkflowEdge>()
  const { take, undo, redo, reset, canUndo, canRedo } = useUndoRedo()
  const abortRef = useRef<AbortController | null>(null)
  const addCountRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const nodeMenuRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // 自动持久化(结构 only)到当前工作流,300ms 防抖。
  useEffect(() => {
    const t = setTimeout(() => saveWorkflowGraph(activeId, { version: 1, nodes, edges }), 300)
    return () => clearTimeout(t)
  }, [activeId, nodes, edges])

  // 键盘:撤销/重做(在输入框内时让位给原生编辑撤销)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  useEffect(() => {
    if (!nodeMenuOpen && !moreMenuOpen) return
    const close = (e: MouseEvent) => {
      const target = e.target as Node
      if (nodeMenuRef.current?.contains(target) || moreMenuRef.current?.contains(target)) return
      setNodeMenuOpen(false)
      setMoreMenuOpen(false)
    }
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setNodeMenuOpen(false)
      setMoreMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [nodeMenuOpen, moreMenuOpen])

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

  const loadTemplate = useCallback(() => {
    const apply = () => {
      take()
      const g = ECOMMERCE_DETAIL_TEMPLATE.build()
      setNodes(g.nodes)
      setEdges(g.edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
    }
    if (getNodes().length === 0) apply()
    else openConfirmDialog({ title: '加载模板', message: '将替换当前画布内容,确定加载「电商详情页一键复刻」模板?', onConfirm: apply })
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
      onNodeDragStart={() => take()}
      onBeforeDelete={async () => {
        take()
        return true
      }}
      nodeTypes={workflowNodeTypes}
      colorMode="system"
      fitView
      minZoom={0.2}
      maxZoom={2}
      defaultEdgeOptions={{ animated: true }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} />

      <Panel position="top-left" className="!m-3">
        <div className="flex flex-col gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 p-2 shadow-sm backdrop-blur">
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
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <ToolbarButton variant="danger" onClick={stop}>■ 停止</ToolbarButton>
            ) : (
              <ToolbarButton variant="primary" onClick={() => void run()}>▶ 运行</ToolbarButton>
            )}
            <span className="mx-1 h-5 w-px bg-[hsl(var(--border))]" />
            <ToolbarButton onClick={undo} disabled={!canUndo || running}>↶ 撤销</ToolbarButton>
            <ToolbarButton onClick={redo} disabled={!canRedo || running}>↷ 重做</ToolbarButton>
            <span className="mx-1 h-5 w-px bg-[hsl(var(--border))]" />
            <div ref={nodeMenuRef} className="relative">
              <ToolbarButton
                onClick={() => {
                  setMoreMenuOpen(false)
                  setNodeMenuOpen((open) => !open)
                }}
                disabled={running}
              >
                + 添加节点
              </ToolbarButton>
              {nodeMenuOpen && (
                <div
                  role="menu"
                  className="animate-dropdown-down absolute left-0 top-full z-20 mt-1 w-40 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 shadow-lg"
                >
                  {PALETTE.map((kind) => (
                    <ToolbarMenuItem
                      key={kind}
                      onClick={() => {
                        setNodeMenuOpen(false)
                        addNode(kind)
                      }}
                    >
                      {NODE_META[kind].title}
                    </ToolbarMenuItem>
                  ))}
                </div>
              )}
            </div>
            <ToolbarButton onClick={loadTemplate} disabled={running}>加载模板</ToolbarButton>
            <div ref={moreMenuRef} className="relative">
              <ToolbarButton
                onClick={() => {
                  setNodeMenuOpen(false)
                  setMoreMenuOpen((open) => !open)
                }}
                disabled={running}
              >
                更多
              </ToolbarButton>
              {moreMenuOpen && (
                <div
                  role="menu"
                  className="animate-dropdown-down absolute right-0 top-full z-20 mt-1 w-36 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 shadow-lg"
                >
                  <ToolbarMenuItem onClick={() => { setMoreMenuOpen(false); handleExport() }}>导出</ToolbarMenuItem>
                  <ToolbarMenuItem onClick={() => { setMoreMenuOpen(false); fileInputRef.current?.click() }}>导入</ToolbarMenuItem>
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
        </div>
      </Panel>

      {nodes.length === 0 && (
        <Panel position="top-center" className="pointer-events-none !mt-32">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-6 text-center shadow-sm">
            <div className="mb-1 text-base font-semibold text-[hsl(var(--foreground))]">工作流画布</div>
            <p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">
              从「电商详情页一键复刻」模板开始,或用上方按钮添加节点,拖动端口连线后点击运行。
            </p>
            <ToolbarButton variant="primary" onClick={loadTemplate}>加载示例模板</ToolbarButton>
          </div>
        </Panel>
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
