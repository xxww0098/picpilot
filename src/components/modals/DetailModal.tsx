import { useEffect, useState, useMemo, useRef } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, updateTaskInStore, showCodexCliPrompt, getCodexCliPromptKey, retryTaskInPlace, retryFailedImages, regenerateTaskImage } from '../../store'
import { logger, serializeError } from '../../lib/shared/logger'
import { useTooltip } from '../../hooks/useTooltip'
import { copyImageSourceToClipboard, copyTextToClipboard, getClipboardFailureMessage } from '../../lib/ui/clipboard'
import { downloadImageIds } from '../../lib/imaging/downloadImages'
import { isAgentTaskPromptPending } from '../../lib/task/taskPromptDisplay'
import { getProviderDisplayName, getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import { getImageModelLabel } from '../../lib/image/imageModels'
import { getTaskFailedImageSource, getTaskImageSource, getUpstreamModeLabel } from '../../lib/task/taskSource'
import { getTaskStreamPreviewItems } from '../../lib/ui/streamPreviews'
import { CloseIcon, CopyIcon } from '../ui/icons'
import ModalShell from '../ui/ModalShell'
import DetailModalMediaPane from '../detailModal/DetailModalMediaPane'
import DetailModalInfoPane from '../detailModal/DetailModalInfoPane'
import DetailModalRawUrlsModal from '../detailModal/DetailModalRawUrlsModal'
import { useDetailModalMedia } from '../detailModal/useDetailModalMedia'

export default function DetailModal() {
  const tasks = useStore((s) => s.tasks)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)
  const dismissedCodexCliPrompts = useStore((s) => s.dismissedCodexCliPrompts)
  const streamPreviewSrc = useStore((s) => detailTaskId ? s.streamPreviews[detailTaskId] || '' : '')
  const streamPreviewSlots = useStore((s) => detailTaskId ? s.streamPreviewSlots[detailTaskId] : undefined)
  const regeneratingImageIndex = useStore((s) => detailTaskId ? s.regeneratingImageSlots[detailTaskId] ?? null : null)

  const [imageIndex, setImageIndex] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [showRawUrlsModal, setShowRawUrlsModal] = useState(false)
  const [showRawResponseModal, setShowRawResponseModal] = useState(false)
  const [streamPreviewLoaded, setStreamPreviewLoaded] = useState(false)
  const [retryingFailed, setRetryingFailed] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const rawUrlsModalRef = useRef<HTMLDivElement>(null)
  const rawResponseModalRef = useRef<HTMLDivElement>(null)

  const copyErrorTooltip = useTooltip()
  const copyRawUrlsTooltip = useTooltip()
  const viewRawResponseTooltip = useTooltip()
  const downloadPartialImagesTooltip = useTooltip()
  const retryTooltip = useTooltip()
  const regenerateImageTooltip = useTooltip()
  const downloadImageTooltip = useTooltip()
  const downloadAllTooltip = useTooltip()

  const clearTextSelection = () => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
  }

  const task = useMemo(
    () => tasks.find((t) => t.id === detailTaskId) ?? null,
    [tasks, detailTaskId],
  )
  const isVideoTask = task?.mediaType === 'video'
  const streamPreviewItems = useMemo(() => getTaskStreamPreviewItems({
    taskOutputCount: task?.status === 'running' || task?.status === 'error' ? task.params.n : 0,
    streamPreviewSrc,
    streamPreviewSlots,
  }), [task?.params.n, task?.status, streamPreviewSlots, streamPreviewSrc])
  const activeStreamPreviewSrc = streamPreviewItems[imageIndex]?.src || ''

  useEffect(() => {
    setStreamPreviewLoaded(false)
  }, [activeStreamPreviewSrc, detailTaskId, imageIndex])

  useEffect(() => {
    const count = task?.status === 'running'
      ? streamPreviewItems.length
      : isVideoTask
      ? (task?.outputVideos?.length ?? 0)
      : (task?.outputImages?.length ?? 0) + (task?.status === 'done' ? (task?.failedImageCount ?? 0) : 0)
    if (count > 0 && imageIndex >= count) setImageIndex(count - 1)
  }, [imageIndex, isVideoTask, streamPreviewItems.length, task?.outputImages?.length, task?.outputVideos?.length, task?.failedImageCount, task?.status])

  // Reset index when task changes
  useEffect(() => {
    setImageIndex(0)
    // 切换到另一条记录时重置"重试中"状态，避免上一条的转圈状态串到当前这条
    setRetryingFailed(false)
  }, [detailTaskId])

  useEffect(() => {
    if (task?.status !== 'running' && !(task?.status === 'error' && task.customRecoverable)) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => window.clearInterval(id)
  }, [task?.customRecoverable, task?.status])

  const {
    imageSrcs,
    imageRatios,
    setImageRatios,
    imageSizes,
    setImageSizes,
    maskPreviewSrc,
    videoSrc,
    videoPosterSrc,
    currentOutputImageId,
    currentOutputPreviewSrc,
    maskTargetId,
    allInputImageIds,
  } = useDetailModalMedia(task, isVideoTask, imageIndex)

  if (!task) return null

  const isAgentTask = task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
  const showPendingPrompt = isAgentTaskPromptPending(task)
  const isAgentEditTool = task.status === 'done' && String(task.agentToolAction ?? '').toLowerCase() === 'edit'
  const showReferenceSection = allInputImageIds.length > 0 || isAgentEditTool

  const outputLen = isVideoTask ? (task.outputVideos?.length || 0) : (task.outputImages?.length || 0)
  // 批量部分失败：把失败的张数也算进翻页槽位，成功槽渲染图片、失败槽显示失败+重试
  const failedSlotCount = task.status === 'done' ? (task.failedImageCount ?? 0) : 0
  const totalSlots = outputLen + failedSlotCount
  const isFailedSlot = failedSlotCount > 0 && imageIndex >= outputLen
  const currentImageRatio = currentOutputImageId ? imageRatios[currentOutputImageId] : ''
  const currentImageSize = currentOutputImageId ? imageSizes[currentOutputImageId] : ''
  const currentActualParams = currentOutputImageId ? task.actualParamsByImage?.[currentOutputImageId] : undefined
  const currentRevisedPrompt = currentOutputImageId ? task.revisedPromptByImage?.[currentOutputImageId]?.trim() : ''
  const showRevisedPrompt = Boolean(currentRevisedPrompt && currentRevisedPrompt !== task.prompt.trim())
  const codexCliPromptKey = getCodexCliPromptKey(settings)
  const hasHandledPromptWarning = settings.codexCli || dismissedCodexCliPrompts.includes(codexCliPromptKey)
  const taskSource = isFailedSlot ? getTaskFailedImageSource(task) : getTaskImageSource(task, currentOutputImageId)
  const taskProvider = taskSource.apiProvider
  const isOpenAiTask = (taskProvider ?? 'openai') === 'openai'
  const showPromptWarning = Boolean(isOpenAiTask && taskSource.apiMode === 'responses' && currentOutputImageId && (!currentRevisedPrompt || showRevisedPrompt) && !hasHandledPromptWarning)
  const taskProviderName = getProviderDisplayName(taskProvider)
  const taskProfileName = taskSource.apiProfileName || '未知'
  const taskModel = taskSource.apiModel ? getImageModelLabel(taskSource.apiModel) : '未知'
  const taskUpstreamLabel = taskProvider === 'openai' ? getUpstreamModeLabel(taskSource.upstreamMode) : ''
  const showSourceInfo = Boolean(taskSource.apiProvider || taskSource.apiProfileName || taskSource.apiModel)
  const isCustomReconnecting = task.status === 'error' && task.customRecoverable
  const rawImageUrls = task.rawImageUrls ?? []
  const streamPreviewLen = streamPreviewItems.length
  const currentStreamPreviewSrc = activeStreamPreviewSrc
  const streamPartialImageIds = task.streamPartialImageIds ?? []
  const displayTaskError = getUserFacingErrorMessage(task.error || '生成失败', '生成失败')
  const isRegeneratingImage = regeneratingImageIndex !== null
  const isRegeneratingCurrentImage = regeneratingImageIndex === imageIndex
  const regenerateCurrentImageUnavailableReason =
    task.status !== 'done'
      ? '当前记录还未完成，不能重新生成单张图片'
      : isVideoTask
      ? '视频记录不能重新生成单张图片'
      : isFailedSlot
      ? '这张生成失败，请使用重试按钮补齐'
      : !currentOutputImageId
      ? '找不到要重新生成的图片'
      : null
  const canRegenerateCurrentImage = regenerateCurrentImageUnavailableReason == null
  const regenerateImageButtonLabel = isRegeneratingCurrentImage
    ? '正在重新生成'
    : isRegeneratingImage && regeneratingImageIndex != null
    ? `第 ${regeneratingImageIndex + 1} 张正在重新生成`
    : '重新生成这一张'

  const formatTime = (ts: number | null) => {
    if (!ts) return ''
    return new Date(ts).toLocaleString('zh-CN')
  }

  const formatDuration = () => {
    if (task.status === 'running' || isCustomReconnecting || isCustomReconnecting) {
      const seconds = Math.max(0, Math.floor((now - task.createdAt) / 1000))
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `${mm}:${ss}`
    }
    if (task.elapsed == null) return null
    const seconds = Math.floor(task.elapsed / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const handleReuse = () => {
    reuseConfig(task)
    setDetailTaskId(null)
  }

  const handleEdit = () => {
    if (!currentOutputImageId) return
    editOutputs(task, [currentOutputImageId])
    setDetailTaskId(null)
  }

  const handleDelete = () => {
    setDetailTaskId(null)
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }

  const handleToggleFavorite = () => {
    updateTaskInStore(task.id, { isFavorite: !task.isFavorite })
  }

  const handleCopyError = async () => {
    const errorText = task.error || '生成失败'
    try {
      await copyTextToClipboard(errorText)
      showToast('完整报错已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制报错失败', err), 'error')
    }
  }

  const handleCopyPrompt = async () => {
    if (!task.prompt) return
    try {
      await copyTextToClipboard(task.prompt)
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制提示词失败', err), 'error')
    }
  }

  const handleShowPromptWarning = () => {
    showCodexCliPrompt(
      true,
      currentRevisedPrompt ? '接口返回的提示词已被改写' : '接口没有返回官方 API 会返回的部分信息',
    )
  }

  const handleCopyInputImage = async () => {
    const imgId = allInputImageIds[0]
    const src = imgId ? imageSrcs[imgId] : ''
    if (!src) return
    try {
      await copyImageSourceToClipboard(src)
      showToast('参考图已复制', 'success')
    } catch (err) {
      logger.error('ui', '复制参考图失败', { error: serializeError(err) })
      showToast(getClipboardFailureMessage('复制参考图失败', err), 'error')
    }
  }

  const handleDownloadCurrentOutput = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isVideoTask) {
      if (!videoSrc || !task) return
      const a = document.createElement('a')
      a.href = videoSrc
      a.download = `task-${task.id}.mp4`
      a.click()
      showToast('下载已开始', 'success')
      return
    }
    if (!currentOutputImageId || !task) return

    try {
      const result = await downloadImageIds([currentOutputImageId], `task-${task.id}`)
      if (result.successCount === 0) {
        showToast('下载失败', 'error')
      } else {
        showToast('下载成功', 'success')
      }
    } catch (err) {
      logger.error('ui', '下载失败', { error: serializeError(err) })
      showToast('下载失败', 'error')
    }
  }

  const handleDownloadAllOutputs = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isVideoTask) {
      await handleDownloadCurrentOutput(e)
      return
    }
    if (!task?.outputImages?.length) return

    try {
      const result = await downloadImageIds(task.outputImages, `task-${task.id}`)
      if (result.successCount === 0) {
        showToast('下载失败', 'error')
      } else if (result.failCount > 0) {
        showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
      } else {
        showToast(result.successCount > 1 ? `下载成功：${result.successCount} 张图片` : '下载成功', 'success')
      }
    } catch (err) {
      logger.error('ui', '下载失败', { error: serializeError(err) })
      showToast('下载失败', 'error')
    }
  }

  const handleDownloadPartialImages = async () => {
    if (!task || !streamPartialImageIds.length) return

    try {
      const result = await downloadImageIds(streamPartialImageIds, `task-${task.id}-partial`)
      if (result.successCount === 0) {
        showToast('下载失败', 'error')
      } else if (result.failCount > 0) {
        showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
      } else {
        showToast(`下载成功：${result.successCount} 张中间步骤图`, 'success')
      }
    } catch (err) {
      logger.error('ui', '下载失败', { error: serializeError(err) })
      showToast('下载失败', 'error')
    }
  }

  const handleRetry = () => {
    // 就地重试：原卡片直接转入运行中，弹窗保持打开以便观察进度
    void retryTaskInPlace(task.id)
  }

  const handleRetryFailed = async () => {
    if (retryingFailed) return
    setRetryingFailed(true)
    try {
      await retryFailedImages(task.id)
    } finally {
      setRetryingFailed(false)
    }
  }

  const handleRegenerateCurrentImage = async () => {
    if (isRegeneratingImage) {
      showToast(`第 ${(regeneratingImageIndex ?? imageIndex) + 1} 张图片正在重新生成，请稍候`, 'info')
      return
    }
    if (!canRegenerateCurrentImage) {
      showToast(regenerateCurrentImageUnavailableReason ?? '当前图片不能重新生成', 'error')
      return
    }
    const targetIndex = imageIndex
    await regenerateTaskImage(task.id, targetIndex)
  }

  return (
    <>
      <ModalShell
        onClose={() => setDetailTaskId(null)}
        scrollRef={[modalRef, rawUrlsModalRef, rawResponseModalRef]}
        panelRef={modalRef}
        zIndexClass="z-50"
        backdropVariant="confirm"
        panelClassName="bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row ring-1 ring-black/5 dark:ring-white/10 animate-modal-in"
      >
        <div className="flex h-14 items-center justify-end px-4 md:hidden">
          <button
            onClick={() => setDetailTaskId(null)}
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400"
            aria-label="关闭"
          >
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>

        {/* 左侧：图片 */}
        <DetailModalMediaPane
          task={task}
          isVideoTask={isVideoTask}
          outputLen={outputLen}
          totalSlots={totalSlots}
          failedSlotCount={failedSlotCount}
          isFailedSlot={isFailedSlot}
          imageIndex={imageIndex}
          setImageIndex={setImageIndex}
          videoSrc={videoSrc}
          videoPosterSrc={videoPosterSrc}
          currentOutputImageId={currentOutputImageId}
          currentOutputPreviewSrc={currentOutputPreviewSrc}
          allInputImageIds={allInputImageIds}
          currentImageRatio={currentImageRatio}
          currentImageSize={currentImageSize}
          setImageRatios={setImageRatios}
          setImageSizes={setImageSizes}
          isRegeneratingImage={isRegeneratingImage}
          isRegeneratingCurrentImage={isRegeneratingCurrentImage}
          regenerateImageButtonLabel={regenerateImageButtonLabel}
          streamPreviewLen={streamPreviewLen}
          currentStreamPreviewSrc={currentStreamPreviewSrc}
          streamPreviewLoaded={streamPreviewLoaded}
          setStreamPreviewLoaded={setStreamPreviewLoaded}
          isCustomReconnecting={isCustomReconnecting}
          displayTaskError={displayTaskError}
          streamPartialImageIds={streamPartialImageIds}
          retryingFailed={retryingFailed}
          showSourceInfo={showSourceInfo}
          taskProviderName={taskProviderName}
          taskUpstreamLabel={taskUpstreamLabel}
          formatDuration={formatDuration}
          setLightboxImageId={setLightboxImageId}
          showToast={showToast}
          setShowRawUrlsModal={setShowRawUrlsModal}
          setShowRawResponseModal={setShowRawResponseModal}
          handleDownloadCurrentOutput={handleDownloadCurrentOutput}
          handleDownloadAllOutputs={handleDownloadAllOutputs}
          handleRegenerateCurrentImage={handleRegenerateCurrentImage}
          handleRetryFailed={handleRetryFailed}
          handleCopyError={handleCopyError}
          handleRetry={handleRetry}
          handleDownloadPartialImages={handleDownloadPartialImages}
          copyErrorTooltip={copyErrorTooltip}
          copyRawUrlsTooltip={copyRawUrlsTooltip}
          viewRawResponseTooltip={viewRawResponseTooltip}
          downloadPartialImagesTooltip={downloadPartialImagesTooltip}
          retryTooltip={retryTooltip}
          regenerateImageTooltip={regenerateImageTooltip}
          downloadImageTooltip={downloadImageTooltip}
          downloadAllTooltip={downloadAllTooltip}
        />

        {/* 右侧：信息 */}
        <DetailModalInfoPane
          task={task}
          isVideoTask={isVideoTask}
          isAgentTask={isAgentTask}
          isAgentEditTool={isAgentEditTool}
          isFailedSlot={isFailedSlot}
          outputLen={outputLen}
          showPendingPrompt={showPendingPrompt}
          showPromptWarning={showPromptWarning}
          showRevisedPrompt={showRevisedPrompt}
          currentRevisedPrompt={currentRevisedPrompt}
          showReferenceSection={showReferenceSection}
          allInputImageIds={allInputImageIds}
          maskTargetId={maskTargetId}
          maskPreviewSrc={maskPreviewSrc}
          imageSrcs={imageSrcs}
          showSourceInfo={showSourceInfo}
          taskProviderName={taskProviderName}
          taskUpstreamLabel={taskUpstreamLabel}
          taskProfileName={taskProfileName}
          taskModel={taskModel}
          taskSource={taskSource}
          currentActualParams={currentActualParams}
          currentOutputImageId={currentOutputImageId}
          setDetailTaskId={setDetailTaskId}
          setLightboxImageId={setLightboxImageId}
          formatTime={formatTime}
          formatDuration={formatDuration}
          handleCopyPrompt={handleCopyPrompt}
          handleShowPromptWarning={handleShowPromptWarning}
          handleCopyInputImage={handleCopyInputImage}
          handleReuse={handleReuse}
          handleEdit={handleEdit}
          handleDelete={handleDelete}
          handleToggleFavorite={handleToggleFavorite}
        />
      </ModalShell>

      {showRawUrlsModal && rawImageUrls.length > 0 && (
        <DetailModalRawUrlsModal
          rawImageUrls={rawImageUrls}
          rawUrlsModalRef={rawUrlsModalRef}
          setShowRawUrlsModal={setShowRawUrlsModal}
          showToast={showToast}
        />
      )}

      {showRawResponseModal && task?.rawResponsePayload && (
        <ModalShell
          portal
          onClose={() => setShowRawResponseModal(false)}
          scrollRef={rawResponseModalRef}
          panelRef={rawResponseModalRef}
          zIndexClass="z-[60]"
          paddingClass="p-4 sm:p-6"
          backdropClassName="bg-black/40 backdrop-blur-sm animate-overlay-in"
          panelClassName="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-[#1c1c1e]"
        >
          <div
            onPointerDown={(e) => {
              if (!(e.target as Element).closest('[data-selectable-text]')) clearTextSelection()
            }}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08] shrink-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">原始响应数据</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(task.rawResponsePayload!)
                      showToast('复制成功', 'success')
                    } catch (err) {
                      showToast(getClipboardFailureMessage('复制失败', err), 'error')
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  全部复制
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawResponseModal(false)}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300 transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 bg-gray-50/50 dark:bg-black/20 overscroll-contain">
              <pre data-selectable-text className="text-[11px] sm:text-xs text-gray-600 dark:text-gray-300 font-mono whitespace-pre-wrap break-all select-text">
                {task.rawResponsePayload.replace(/"(b64_json|base64|data)":\s*"[^"]+"/g, '"$1": "<base64_data>"')}
              </pre>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  )
}
