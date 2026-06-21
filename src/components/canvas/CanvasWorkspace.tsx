// 画布工作区主组件：挂载 tldraw 无限画布，绑定 store 持久化 + AI 出图面板。
// 能力：多文档切换、AI 占位框、文生图填入占位框、图生图迭代（选中图→再生成）。
// 标注迭代（阶段 4）在 CanvasAgentPanel 上逐步加入。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Tldraw, type Editor, type TLStoreSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import type { CanvasDocument, TLDSnapshot } from '../../types'
import { useStore } from '../../store'
import { hydrateCanvasSnapshot } from '../../lib/canvas/canvasPersistence'
import { AI_IMAGE_HOLDER_META_KEY } from '../../lib/canvas/canvasImageAsset'
import { downloadCanvasFile, parseCanvasFile } from '../../lib/canvas/exportCanvas'
import { openConfirmDialog, openPromptDialog } from '../../lib/ui/dialog'
import CanvasAgentPanel from './CanvasAgentPanel'

const AI_IMAGE_HOLDER_DEFAULT_W = 320
const AI_IMAGE_HOLDER_DEFAULT_H = 220

// picpilot 的 TLDSnapshot（unknown 结构）↔ tldraw 的 TLStoreSnapshot 互转。
// tldraw 的 SerializedSchema/records 类型在运行时生成，用断言收敛即可。
function toTldrawSnapshot(snapshot: TLDSnapshot): TLStoreSnapshot {
  return snapshot as unknown as TLStoreSnapshot
}

function editorToSnapshot(editor: Editor): TLDSnapshot {
  // editor.getSnapshot() 返回 TLEditorSnapshot{ document, session }；
  // 我们只持久化 document（TLStoreSnapshot，含 schema + store records）。
  const doc = editor.getSnapshot().document
  return {
    schema: doc.schema as unknown,
    store: doc.store as Record<string, unknown>,
  }
}

export default function CanvasWorkspace() {
  const canvases = useStore((s) => s.canvases)
  const canvasesLoaded = useStore((s) => s.canvasesLoaded)
  const activeCanvasId = useStore((s) => s.activeCanvasId)
  const createCanvas = useStore((s) => s.createCanvas)
  const setActiveCanvasId = useStore((s) => s.setActiveCanvasId)
  const renameCanvas = useStore((s) => s.renameCanvas)
  const deleteCanvas = useStore((s) => s.deleteCanvas)
  const updateCanvasSnapshot = useStore((s) => s.updateCanvasSnapshot)

  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedCanvasIdRef = useRef<string | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)
  // 用作 Tldraw key 强制重挂载切换文档；首次渲染前需先把当前文档快照备好
  const [mountSnapshot, setMountSnapshot] = useState<TLStoreSnapshot | null>(null)

  const activeCanvas = canvases.find((c) => c.id === activeCanvasId) ?? canvases[canvases.length - 1] ?? null

  // 没有画布时自动建一个；activeCanvasId 失效时回退到最后一个
  useEffect(() => {
    if (!canvasesLoaded) return
    if (canvases.length === 0) {
      createCanvas()
    } else if (!activeCanvasId || !canvases.some((c) => c.id === activeCanvasId)) {
      setActiveCanvasId(canvases[canvases.length - 1].id)
    }
  }, [canvasesLoaded, canvases, activeCanvasId, createCanvas, setActiveCanvasId])

  // 切换画布：异步恢复图片 dataUrl → 备好快照 → 重挂载 Tldraw
  useEffect(() => {
    if (!activeCanvas) {
      setMountSnapshot(null)
      return
    }
    if (loadedCanvasIdRef.current === activeCanvas.id) return
    loadedCanvasIdRef.current = activeCanvas.id
    let cancelled = false
    void (async () => {
      const snapshot = await hydrateCanvasSnapshot(activeCanvas.snapshot)
      if (cancelled) return
      setMountSnapshot(Object.keys(snapshot.store).length > 0 ? toTldrawSnapshot(snapshot) : null)
    })()
    return () => {
      cancelled = true
    }
  }, [activeCanvas])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const editor = editorRef.current
      const canvasId = loadedCanvasIdRef.current
      if (!editor || !canvasId) return
      updateCanvasSnapshot(canvasId, editorToSnapshot(editor))
    }, 500)
  }, [updateCanvasSnapshot])

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    // 监听 store 变更，防抖写回 picpilot store（store 的 subscribe 会异步落库 IndexedDB）
    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }
    unlistenRef.current = editor.store.listen(scheduleSave, { source: 'user', scope: 'document' })
  }, [scheduleSave])

  // 卸载时立即 flush 一次 + 解绑监听
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        const editor = editorRef.current
        const canvasId = loadedCanvasIdRef.current
        if (editor && canvasId) updateCanvasSnapshot(canvasId, editorToSnapshot(editor))
      }
    }
  }, [updateCanvasSnapshot])

  const handleCreateCanvas = useCallback(() => {
    createCanvas()
  }, [createCanvas])

  const handleRenameCanvas = useCallback((canvas: CanvasDocument) => {
    openPromptDialog({
      title: '重命名画布',
      defaultValue: canvas.title,
      placeholder: '输入画布名称',
      onConfirm: async (title) => {
        if (title.trim()) renameCanvas(canvas.id, title.trim())
      },
    })
  }, [renameCanvas])

  const handleDeleteCanvas = useCallback((canvas: CanvasDocument) => {
    openConfirmDialog({
      title: '删除画布',
      message: `确定删除「${canvas.title}」吗？画布上的所有内容将被清除。`,
      tone: 'danger',
      confirmText: '删除',
      onConfirm: async () => {
        deleteCanvas(canvas.id)
      },
    })
  }, [deleteCanvas])

  // 创建 AI 占位框（阶段 2 预留入口）
  const handleCreateAiHolder = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const scale = editor.getResizeScaleFactor?.() ?? 1
    const w = AI_IMAGE_HOLDER_DEFAULT_W * scale
    const h = AI_IMAGE_HOLDER_DEFAULT_H * scale
    const center = editor.getViewportPageBounds().center
    editor.createShape({
      type: 'frame',
      x: center.x - w / 2,
      y: center.y - h / 2,
      props: { w, h, name: 'AI 图片', color: 'blue' },
      meta: { [AI_IMAGE_HOLDER_META_KEY]: true },
    })
  }, [])

  const handleExportCanvas = useCallback(() => {
    if (!activeCanvas) return
    downloadCanvasFile(activeCanvas)
  }, [activeCanvas])

  const handleImportCanvas = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const imported = await parseCanvasFile(file)
      if (!imported) {
        useStore.getState().showToast('无法解析画布文件，请检查文件格式', 'error')
        return
      }
      const id = imported.id
      useStore.setState((state) => ({
        canvases: [...state.canvases, imported],
        activeCanvasId: id,
      }))
      useStore.getState().showToast(`已导入画布「${imported.title}」`, 'success')
    }
    input.click()
  }, [])

  if (!canvasesLoaded) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
        加载画布…
      </div>
    )
  }

  return (
    <div className="fixed inset-0 top-[3.25rem] z-0 flex flex-col bg-white dark:bg-gray-950">
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/[0.08] px-3 py-2 shrink-0">
        <select
          value={activeCanvasId ?? ''}
          onChange={(e) => setActiveCanvasId(e.target.value)}
          className="max-w-[12rem] rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
          aria-label="选择画布"
        >
          {canvases.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleCreateCanvas}
          className="px-2.5 py-1 rounded-lg text-sm bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/[0.1]"
        >
          + 新建
        </button>
        {activeCanvas && (
          <>
            <button
              type="button"
              onClick={() => handleRenameCanvas(activeCanvas)}
              className="px-2.5 py-1 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => handleDeleteCanvas(activeCanvas)}
              className="px-2.5 py-1 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              删除
            </button>
            <button
              type="button"
              onClick={handleExportCanvas}
              className="px-2.5 py-1 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
              导出
            </button>
          </>
        )}
        <button
          type="button"
          onClick={handleImportCanvas}
          className="px-2.5 py-1 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
        >
          导入
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleCreateAiHolder}
          className="px-3 py-1 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700"
        >
          + AI 占位框
        </button>
      </div>

      <div className="flex-1 relative">
        <Tldraw
          key={activeCanvasId ?? 'empty'}
          snapshot={mountSnapshot ?? undefined}
          onMount={handleMount}
          colorScheme="system"
        />
      </div>

      <CanvasAgentPanel editorRef={editorRef} />
    </div>
  )
}
