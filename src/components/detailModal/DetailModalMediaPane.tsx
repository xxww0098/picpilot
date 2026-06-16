import type { Dispatch, MouseEvent, SetStateAction } from 'react'
import { formatImageRatio } from '../../lib/params/size'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../lib/ui/clipboard'
import { dismissAllTooltips } from '../../lib/ui/tooltipDismiss'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import { CodeIcon, CopyIcon, DownloadIcon, LinkIcon, RefreshIcon } from '../icons'
import PublishGalleryButton from '../PublishGalleryButton'
import ViewportTooltip from '../ViewportTooltip'
import type { useTooltip } from '../../hooks/useTooltip'
import type { AppState } from '../../store'
import type { TaskRecord } from '../../types'

type TooltipController = ReturnType<typeof useTooltip>

export type DetailModalMediaPaneProps = {
  task: TaskRecord
  isVideoTask: boolean
  outputLen: number
  totalSlots: number
  failedSlotCount: number
  isFailedSlot: boolean
  imageIndex: number
  setImageIndex: Dispatch<SetStateAction<number>>
  videoSrc: string
  videoPosterSrc: string
  currentOutputImageId: string
  currentOutputPreviewSrc: string
  allInputImageIds: string[]
  currentImageRatio: string | undefined
  currentImageSize: string | undefined
  setImageRatios: Dispatch<SetStateAction<Record<string, string>>>
  setImageSizes: Dispatch<SetStateAction<Record<string, string>>>
  isRegeneratingImage: boolean
  isRegeneratingCurrentImage: boolean
  regenerateImageButtonLabel: string
  streamPreviewLen: number
  currentStreamPreviewSrc: string
  streamPreviewLoaded: boolean
  setStreamPreviewLoaded: Dispatch<SetStateAction<boolean>>
  isCustomReconnecting: boolean | undefined
  displayTaskError: string
  streamPartialImageIds: string[]
  retryingFailed: boolean
  showSourceInfo: boolean
  taskProviderName: string
  taskUpstreamLabel: string
  formatDuration: () => string | null
  setLightboxImageId: AppState['setLightboxImageId']
  showToast: AppState['showToast']
  setShowRawUrlsModal: Dispatch<SetStateAction<boolean>>
  setShowRawResponseModal: Dispatch<SetStateAction<boolean>>
  handleDownloadCurrentOutput: (e: MouseEvent) => Promise<void>
  handleDownloadAllOutputs: (e: MouseEvent) => Promise<void>
  handleRegenerateCurrentImage: () => Promise<void>
  handleRetryFailed: () => Promise<void>
  handleCopyError: () => Promise<void>
  handleRetry: () => void
  handleDownloadPartialImages: () => Promise<void>
  copyErrorTooltip: TooltipController
  copyRawUrlsTooltip: TooltipController
  viewRawResponseTooltip: TooltipController
  downloadPartialImagesTooltip: TooltipController
  retryTooltip: TooltipController
  regenerateImageTooltip: TooltipController
  downloadImageTooltip: TooltipController
  downloadAllTooltip: TooltipController
}

export default function DetailModalMediaPane({
  task,
  isVideoTask,
  outputLen,
  totalSlots,
  failedSlotCount,
  isFailedSlot,
  imageIndex,
  setImageIndex,
  videoSrc,
  videoPosterSrc,
  currentOutputImageId,
  currentOutputPreviewSrc,
  allInputImageIds,
  currentImageRatio,
  currentImageSize,
  setImageRatios,
  setImageSizes,
  isRegeneratingImage,
  isRegeneratingCurrentImage,
  regenerateImageButtonLabel,
  streamPreviewLen,
  currentStreamPreviewSrc,
  streamPreviewLoaded,
  setStreamPreviewLoaded,
  isCustomReconnecting,
  displayTaskError,
  streamPartialImageIds,
  retryingFailed,
  showSourceInfo,
  taskProviderName,
  taskUpstreamLabel,
  formatDuration,
  setLightboxImageId,
  showToast,
  setShowRawUrlsModal,
  setShowRawResponseModal,
  handleDownloadCurrentOutput,
  handleDownloadAllOutputs,
  handleRegenerateCurrentImage,
  handleRetryFailed,
  handleCopyError,
  handleRetry,
  handleDownloadPartialImages,
  copyErrorTooltip,
  copyRawUrlsTooltip,
  viewRawResponseTooltip,
  downloadPartialImagesTooltip,
  retryTooltip,
  regenerateImageTooltip,
  downloadImageTooltip,
  downloadAllTooltip,
}: DetailModalMediaPaneProps) {
  return (
        <div className="md:w-1/2 w-full h-64 md:h-auto bg-gray-100 dark:bg-black/20 relative flex items-center justify-center flex-shrink-0 min-h-[16rem]">
          {task.status === 'done' && isVideoTask && outputLen > 0 && (
            <div className="absolute right-3 top-[15px] z-20 flex items-center gap-1.5">
              <div className="relative group flex">
                <button
                  type="button"
                  {...downloadImageTooltip.handlers}
                  onClick={(e) => {
                    downloadImageTooltip.handlers.onClick()
                    handleDownloadCurrentOutput(e)
                  }}
                  className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                  aria-label="下载视频"
                >
                  <DownloadIcon className="h-4 w-4" />
                </button>
                <ViewportTooltip visible={downloadImageTooltip.visible} className="whitespace-nowrap">
                  下载视频
                </ViewportTooltip>
              </div>
            </div>
          )}
          {task.status === 'done' && !isVideoTask && outputLen > 0 && !isFailedSlot && (
            <div className="absolute right-3 top-[15px] z-20 flex items-center gap-1.5">
              <div className="relative group flex">
                <button
                  type="button"
                  {...regenerateImageTooltip.handlers}
                  onClick={(e) => {
                    e.stopPropagation()
                    regenerateImageTooltip.handlers.onClick()
                    void handleRegenerateCurrentImage()
                  }}
                  disabled={isRegeneratingImage}
                  className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 disabled:cursor-wait disabled:opacity-70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                  aria-label={regenerateImageButtonLabel}
                >
                  <RefreshIcon className={`h-4 w-4 ${isRegeneratingCurrentImage ? 'animate-spin' : ''}`} />
                </button>
                <ViewportTooltip visible={regenerateImageTooltip.visible} className="whitespace-nowrap">
                  {regenerateImageButtonLabel}
                </ViewportTooltip>
              </div>
              {currentOutputImageId && (
                <PublishGalleryButton imageId={currentOutputImageId} prompt={task.prompt ?? ''} originalImageIds={allInputImageIds} />
              )}
              <div className="relative group flex">
                <button
                  type="button"
                  {...downloadImageTooltip.handlers}
                  onClick={(e) => {
                    downloadImageTooltip.handlers.onClick()
                    handleDownloadCurrentOutput(e)
                  }}
                    className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                  aria-label="下载图片"
                >
                  <DownloadIcon className="h-4 w-4" />
                </button>
                <ViewportTooltip visible={downloadImageTooltip.visible} className="whitespace-nowrap">
                  下载图片
                </ViewportTooltip>
              </div>
              {outputLen > 1 && (
                <div className="relative group flex">
                  <button
                    type="button"
                    {...downloadAllTooltip.handlers}
                    onClick={(e) => {
                      downloadAllTooltip.handlers.onClick()
                      handleDownloadAllOutputs(e)
                    }}
                    className="flex items-center justify-center pl-1.5 pr-2 py-0.5 gap-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label="下载全部"
                  >
                    <DownloadIcon className="h-4 w-4" />
                    <span className="text-[9px] font-bold leading-none mt-[1px]">全部</span>
                  </button>
                  <ViewportTooltip visible={downloadAllTooltip.visible} className="whitespace-nowrap">
                    下载全部
                  </ViewportTooltip>
                </div>
              )}
            </div>
          )}
          {task.status === 'done' && isVideoTask && outputLen > 0 && videoSrc && (
            <>
              <video
                src={videoSrc}
                poster={videoPosterSrc || undefined}
                className="max-h-full max-w-full bg-black"
                controls
                playsInline
                preload="metadata"
              />
              <div data-selectable-text className="absolute left-4 top-[15px] flex items-center gap-1.5">
                {formatDuration() && (
                  <span className="flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {formatDuration()}
                  </span>
                )}
              </div>
            </>
          )}
          {task.status === 'done' && outputLen > 0 && currentOutputPreviewSrc && !isFailedSlot && (
            <>
              <img
                src={currentOutputPreviewSrc}
                data-image-id={currentOutputImageId}
                className={`saveable-image max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain cursor-pointer transition-opacity ${isRegeneratingCurrentImage ? 'opacity-60' : ''}`}
                onLoad={(e) => {
                  const image = e.currentTarget
                  if (currentOutputImageId && image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setImageRatios((prev) => ({
                      ...prev,
                      [currentOutputImageId]: formatImageRatio(image.naturalWidth, image.naturalHeight),
                    }))
                    setImageSizes((prev) => ({
                      ...prev,
                      [currentOutputImageId]: `${image.naturalWidth}×${image.naturalHeight}`,
                    }))
                  }
                }}
                onClick={() =>
                  setLightboxImageId(task.outputImages[imageIndex], task.outputImages)
                }
                alt=""
              />
              <div data-selectable-text className="absolute left-4 top-[15px] flex items-center gap-1.5">
                {currentImageRatio && currentImageSize ? (
                  <>
                    <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      {currentImageRatio}
                    </span>
                    <span className="bg-black/50 text-white/90 text-xs px-2 py-0.5 rounded backdrop-blur-sm font-medium">
                      {currentImageSize}
                    </span>
                  </>
                ) : (
                  formatDuration() && (
                    <span className="flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {formatDuration()}
                    </span>
                  )
                )}
              </div>
              {isRegeneratingCurrentImage && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/25 backdrop-blur-[1px]">
                  <div className="inline-flex items-center gap-2 rounded bg-black/70 px-3 py-1.5 text-xs font-medium text-white shadow-sm">
                    <RefreshIcon className="h-4 w-4 animate-spin" />
                    <span>正在重新生成这一张</span>
                  </div>
                </div>
              )}
            </>
          )}
          {task.status === 'done' && !isVideoTask && outputLen > 0 && currentOutputImageId && !currentOutputPreviewSrc && !isFailedSlot && (
            <div className="flex flex-col items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <RefreshIcon className="h-6 w-6 animate-spin text-blue-400" />
              <span>正在载入图片</span>
            </div>
          )}
          {isFailedSlot && (
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-red-500 dark:bg-red-500/15 dark:text-red-400">
                <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-red-500 dark:text-red-400">这一张生成失败</p>
              {showSourceInfo && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  失败来源：{[taskProviderName, taskUpstreamLabel].filter(Boolean).join(' · ')}
                </p>
              )}
              {task.partialImageErrors?.[0] && (
                <p className="line-clamp-3 max-w-xs text-xs leading-relaxed text-gray-500 dark:text-gray-400">{getUserFacingErrorMessage(task.partialImageErrors[0])}</p>
              )}
              <button
                onClick={handleRetryFailed}
                disabled={retryingFailed}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg className={`h-4 w-4 ${retryingFailed ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {retryingFailed ? '重试中…' : failedSlotCount > 1 ? `重试失败的 ${failedSlotCount} 张` : '重试这一张'}
              </button>
            </div>
          )}
          {task.status === 'done' && !isVideoTask && totalSlots > 1 && (
            <>
              <button
                onClick={() => setImageIndex((imageIndex - 1 + totalSlots) % totalSlots)}
                className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                aria-label="上一张"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => setImageIndex((imageIndex + 1) % totalSlots)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                aria-label="下一张"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                {imageIndex + 1} / {totalSlots}
              </span>
            </>
          )}
          {(task.status === 'running' || isCustomReconnecting) && (
            <>
              <div className="absolute left-4 top-4 flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {formatDuration()}
              </div>
              {task.status === 'running' && streamPreviewLen > 0 && (
                <>
                  {currentStreamPreviewSrc ? (
                    <img
                      src={currentStreamPreviewSrc}
                      className={`max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain ${streamPreviewLoaded ? '' : 'hidden'}`}
                      alt=""
                      onLoad={() => setStreamPreviewLoaded(true)}
                      onError={() => setStreamPreviewLoaded(false)}
                    />
                  ) : null}
                  {(!currentStreamPreviewSrc || !streamPreviewLoaded) && (
                    <svg className="w-10 h-10 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {streamPreviewLoaded && (
                    <span className="absolute top-4 right-4 flex items-center gap-1 rounded bg-blue-500 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                      流式预览
                    </span>
                  )}
                  {streamPreviewLen > 1 && (
                    <>
                      <button
                        onClick={() => setImageIndex((imageIndex - 1 + streamPreviewLen) % streamPreviewLen)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setImageIndex((imageIndex + 1) % streamPreviewLen)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                        {imageIndex + 1} / {streamPreviewLen}
                      </span>
                    </>
                  )}
                </>
              )}
              {task.status === 'running' && streamPreviewLen === 0 && (
                <svg className="w-10 h-10 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </>
          )}
          {task.status === 'error' && isCustomReconnecting && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-yellow-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <p className="text-sm font-medium text-yellow-500">重连中</p>
            </div>
          )}
          {task.status === 'error' && !isCustomReconnecting && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p
                className="overflow-hidden whitespace-pre-line text-sm leading-6 text-red-500 break-words"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 10,
                }}
              >
                {displayTaskError}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <div className="relative group">
                  <button
                    type="button"
                    {...copyErrorTooltip.handlers}
                    onClick={() => {
                      copyErrorTooltip.handlers.onClick()
                      handleCopyError()
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-red-200/80 bg-white/80 px-3 py-1.5 text-red-500 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-white/[0.04] dark:hover:bg-red-500/10"
                    aria-label="复制完整报错"
                  >
                    <CopyIcon className="h-4 w-4" />
                  </button>
                  <ViewportTooltip visible={copyErrorTooltip.visible} className="whitespace-nowrap">
                    复制完整报错
                  </ViewportTooltip>
                </div>
                {task.rawResponsePayload && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...viewRawResponseTooltip.handlers}
                      onClick={() => {
                        dismissAllTooltips()
                        setShowRawResponseModal(true)
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-purple-200/80 bg-purple-50 px-3 py-1.5 text-purple-600 transition hover:bg-purple-100 dark:border-purple-500/20 dark:bg-purple-500/10 dark:text-purple-400 dark:hover:bg-purple-500/20"
                      aria-label="查看原始响应"
                    >
                      <CodeIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={viewRawResponseTooltip.visible} className="whitespace-nowrap">
                      查看原始响应
                    </ViewportTooltip>
                  </div>
                )}
                {task.rawImageUrls && task.rawImageUrls.length > 0 && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...copyRawUrlsTooltip.handlers}
                      onClick={async () => {
                        if (task.rawImageUrls!.length === 1) {
                          copyRawUrlsTooltip.handlers.onClick()
                          try {
                            await copyTextToClipboard(task.rawImageUrls![0])
                            showToast('图片链接已复制', 'success')
                          } catch (err) {
                            showToast(getClipboardFailureMessage('复制链接失败', err), 'error')
                          }
                        } else {
                          dismissAllTooltips()
                          setShowRawUrlsModal(true)
                        }
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-green-200/80 bg-green-50 px-3 py-1.5 text-green-600 transition hover:bg-green-100 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20"
                      aria-label="复制图片链接"
                    >
                      <LinkIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={copyRawUrlsTooltip.visible} className="whitespace-nowrap">
                      复制图片链接
                    </ViewportTooltip>
                  </div>
                )}
                {streamPartialImageIds.length > 0 && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...downloadPartialImagesTooltip.handlers}
                      onClick={() => {
                        downloadPartialImagesTooltip.handlers.onClick()
                        void handleDownloadPartialImages()
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-amber-200/80 bg-amber-50 px-3 py-1.5 text-amber-600 transition hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20"
                      aria-label="下载中间步骤图"
                    >
                      <DownloadIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={downloadPartialImagesTooltip.visible} className="whitespace-nowrap">
                      下载中间步骤图
                    </ViewportTooltip>
                  </div>
                )}
                <div className="relative group">
                  <button
                    type="button"
                    {...retryTooltip.handlers}
                    onClick={() => {
                      retryTooltip.handlers.onClick()
                      handleRetry()
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-blue-200/80 bg-white/80 px-3 py-1.5 text-blue-500 transition hover:bg-blue-50 dark:border-blue-400/20 dark:bg-white/[0.04] dark:hover:bg-blue-500/10"
                    aria-label="重试任务"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  <ViewportTooltip visible={retryTooltip.visible} className="whitespace-nowrap">
                    重试任务
                  </ViewportTooltip>
                </div>
              </div>
            </div>
          )}
        </div>
  )
}
