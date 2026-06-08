import { useCallback, useMemo } from 'react'
import { removeMultipleTasks, retryTaskInPlace, updateTaskInStore, useStore } from '../../store'
import { downloadImageIds, formatExportFileTime } from '../../lib/downloadImages'
import { logger, serializeError } from '../../lib/logger'

export default function InputBarBatchToolbar() {
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const tasks = useStore((s) => s.tasks)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const searchQuery = useStore((s) => s.searchQuery)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setPrompt = useStore((s) => s.setPrompt)
  const showToast = useStore((s) => s.showToast)

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()

    return sorted.filter((t) => {
      if (filterFavorite && !t.isFavorite) return false
      const matchStatus = filterStatus === 'all' || t.status === filterStatus
      if (!matchStatus) return false

      if (!q) return true
      const prompt = (t.prompt || '').toLowerCase()
      const paramStr = JSON.stringify(t.params).toLowerCase()
      return prompt.includes(q) || paramStr.includes(q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite])

  const handleSelectAllToggle = useCallback(() => {
    if (selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0) {
      clearSelection()
    } else {
      setSelectedTaskIds(filteredTasks.map((t) => t.id))
    }
  }, [selectedTaskIds.length, filteredTasks, setSelectedTaskIds, clearSelection])

  const handleToggleFavorite = useCallback(() => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const allFavorite = selectedTasks.length > 0 && selectedTasks.every((t) => t.isFavorite)
    const newFavoriteState = !allFavorite
    setConfirmDialog({
      title: newFavoriteState ? '批量收藏' : '批量取消收藏',
      message: newFavoriteState
        ? `确定要收藏选中的 ${selectedTaskIds.length} 条记录吗？`
        : `确定要取消收藏选中的 ${selectedTaskIds.length} 条记录吗？`,
      confirmText: newFavoriteState ? '确认收藏' : '确认取消',
      action: () => {
        selectedTaskIds.forEach((id) => {
          updateTaskInStore(id, { isFavorite: newFavoriteState })
        })
        clearSelection()
      },
    })
  }, [tasks, selectedTaskIds, setConfirmDialog, clearSelection])

  const handleDeleteSelected = useCallback(() => {
    setConfirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${selectedTaskIds.length} 条记录吗？`,
      action: () => {
        removeMultipleTasks(selectedTaskIds)
      },
    })
  }, [selectedTaskIds, setConfirmDialog])

  const handleDownloadSelected = useCallback(async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const imageIds = selectedTasks.flatMap((t) => t.outputImages || [])
    if (imageIds.length === 0) {
      showToast('选中的记录没有图片', 'info')
      return
    }

    try {
      const timeStr = formatExportFileTime(new Date())
      const { successCount, failCount } = await downloadImageIds(imageIds, `batch-${timeStr}`)

      if (successCount === 0) {
        showToast('下载失败', 'error')
      } else if (failCount > 0) {
        showToast(`部分下载失败：成功 ${successCount}，失败 ${failCount}`, 'error')
      } else {
        showToast(successCount > 1 ? `下载成功：${successCount} 张图片` : '下载成功', 'success')
      }
    } catch (err) {
      logger.error('ui', '批量下载失败', { error: serializeError(err) })
      showToast('下载失败', 'error')
    }
    clearSelection()
  }, [tasks, selectedTaskIds, showToast, clearSelection])

  const handleCreateBatchDraft = useCallback(() => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const prompts = selectedTasks
      .map((task) => task.prompt.trim())
      .filter(Boolean)
    if (prompts.length === 0) {
      showToast('选中的记录没有提示词', 'info')
      return
    }
    setPrompt(prompts.join('\n\n---\n\n'))
    clearSelection()
    showToast(`已生成 ${prompts.length} 条批量草稿`, 'success')
  }, [tasks, selectedTaskIds, setPrompt, showToast, clearSelection])

  const handleRetrySelectedErrors = useCallback(async () => {
    const errorTasks = tasks.filter((task) => selectedTaskIds.includes(task.id) && task.status === 'error')
    if (errorTasks.length === 0) {
      showToast('选中的记录没有失败任务', 'info')
      return
    }
    clearSelection()
    showToast(`开始恢复 ${errorTasks.length} 个失败任务`, 'info')
    for (const task of errorTasks) {
      await retryTaskInPlace(task.id)
    }
  }, [tasks, selectedTaskIds, showToast, clearSelection])

  if (selectedTaskIds.length === 0) return null

  return (
    <div className="flex justify-center mb-3">
      <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-lg rounded-full flex items-center p-1 border border-gray-200/50 dark:border-white/10 pointer-events-auto">
        <button
          onClick={clearSelection}
          className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
          title="取消选择"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1" />
        <button
          onClick={handleSelectAllToggle}
          className="p-2 text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
          title={selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0 ? '取消全选' : '全选当前可见'}
        >
          {selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0 ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path strokeDasharray="4 4" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
            </svg>
          )}
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1" />
        <button
          onClick={handleCreateBatchDraft}
          className="p-2 text-indigo-500 dark:text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors"
          title="生成批量草稿"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M4 4h16v16H4z" />
            <path d="M8 8h8M8 12h8M8 16h5" />
          </svg>
        </button>
        <button
          onClick={() => void handleRetrySelectedErrors()}
          className="p-2 text-cyan-500 dark:text-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-300 transition-colors"
          title="恢复失败任务"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1" />
        <button
          onClick={handleToggleFavorite}
          className="p-2 text-yellow-500 dark:text-yellow-400 hover:text-yellow-600 dark:hover:text-yellow-300 transition-colors"
          title="收藏/取消收藏"
        >
          {selectedTaskIds.length > 0 && selectedTaskIds.every((id) => tasks.find((t) => t.id === id)?.isFavorite) ? (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          )}
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1" />
        <button
          onClick={handleDownloadSelected}
          className="p-2 text-green-500 dark:text-green-400 hover:text-green-600 dark:hover:text-green-300 transition-colors"
          title="批量下载"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </button>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1" />
        <button
          onClick={handleDeleteSelected}
          className="p-2 text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
          title="删除选中"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  )
}
