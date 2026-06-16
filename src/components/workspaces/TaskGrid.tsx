import { useMemo, useRef, useState, useEffect } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, filterGalleryTasks } from '../../store'
import TaskCard from './TaskCard'
import { openDestructiveConfirm } from '../../lib/ui/dialog'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const appMode = useStore((s) => s.appMode)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectionBox, setSelectionBox] = useState<{ startPageX: number; startPageY: number; currentPageX: number; currentPageY: number } | null>(null)
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const isDragging = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const lastToastTimeRef = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const filteredTasks = useMemo(
    () => filterGalleryTasks(tasks, { searchQuery, filterStatus, filterFavorite })
      .filter((task) => appMode === 'video' ? task.mediaType === 'video' : task.mediaType !== 'video'),
    [tasks, searchQuery, filterStatus, filterFavorite, appMode],
  )

  const handleDelete = (task: typeof tasks[0]) => {
    const isVideo = task.mediaType === 'video'
    openDestructiveConfirm({
      title: isVideo ? '删除视频记录' : '删除记录',
      message: isVideo
        ? '确定要删除这条视频记录吗？缓存的视频文件也会被清理（如果没有其他任务引用）。'
        : '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      confirmText: isVideo ? '删除视频' : '删除记录',
      onConfirm: () => removeTask(task),
    })
  }

  const getPagePoint = (clientX: number, clientY: number) => ({
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
  })

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    const point = getPagePoint(clientX, clientY)

    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }

  const updateSelectionFromPoint = (pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskId = card.getAttribute('data-task-id')
      if (!taskId) return

      const cardLeft = rect.left + window.scrollX
      const cardRight = rect.right + window.scrollX
      const cardTop = rect.top + window.scrollY
      const cardBottom = rect.bottom + window.scrollY

      const isIntersecting =
        minX < cardRight && maxX > cardLeft && minY < cardBottom && maxY > cardTop

      if (isIntersecting) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        window.scrollBy({ top: direction * 15, behavior: 'instant' })
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && clearEmptySurfaceClick && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && suppressClick && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      stopDragScroll()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()

      const scrollThreshold = 40
      if (e.clientY < scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > window.innerHeight - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (!isDragging.current || !dragStart.current || !lastClientPoint.current || !hasDragged.current) return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      const start = dragStart.current
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return

      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTimeRef.current > 3000) {
        lastToastTimeRef.current = now
        const keyName = isMac ? '⌘' : 'Ctrl'
        useStore.getState().showToast(`松开 ${keyName} 键使用滚轮，或拖至边缘自动滚动`, 'info')
      }
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [clearSelection, isMac])

  if (!filteredTasks.length) {
    const isVideo = appMode === 'video'
    const isFiltered = Boolean(searchQuery || filterFavorite)
    return (
      <div className="flex flex-col items-center justify-center px-6 py-14 text-center sm:py-24">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
          {isFiltered ? (
            <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          ) : (
            <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          )}
        </div>
        {isFiltered ? (
          <>
            <h2 className="text-base font-semibold text-[hsl(var(--foreground))]">没有匹配的记录</h2>
            <p className="mt-1.5 max-w-xs text-sm text-[hsl(var(--muted-foreground))]">试试调整搜索词或筛选条件。</p>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-[hsl(var(--foreground))]">{isVideo ? '还没有视频' : '还没有图片'}</h2>
            <p className="mt-1.5 max-w-[18rem] text-sm leading-relaxed text-[hsl(var(--muted-foreground))] sm:max-w-sm">
              {isVideo ? (
                '在下方输入框描述你想要的视频即可开始生成。'
              ) : (
                <>
                  <span className="sm:hidden">在下方输入提示词即可开始生成。</span>
                  <span className="hidden sm:inline">在下方输入框描述你想要的画面即可开始生成，支持输入 @ 引用参考图，或从「提示词模板」快速起步。</span>
                </>
              )}
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div 
      ref={rootRef}
      data-task-grid-root
      className="relative min-h-[50vh]"
    >
      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
        {filteredTasks.map((task) => (
          <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
            <TaskCard
              task={task}
              onClick={(e) => {
                if (Date.now() < suppressClickUntil.current) {
                  e.preventDefault()
                  return
                }
                suppressClickUntil.current = 0
                const isCtrl = isMac ? e.metaKey : e.ctrlKey
                if (isCtrl) {
                  useStore.getState().toggleTaskSelection(task.id)
                  return
                }

                setDetailTaskId(task.id)
              }}
              onReuse={() => reuseConfig(task)}
              onEditOutputs={() => editOutputs(task)}
              onDelete={() => handleDelete(task)}
              isSelected={selectedTaskIds.includes(task.id)}
            />
          </div>
        ))}
      </div>
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
    </div>
  )
}
