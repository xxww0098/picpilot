import { ActualValueBadge, DetailParamValue } from '../../lib/params/paramDisplay'
import { CloseIcon, CopyIcon, EditIcon, TrashIcon } from '../ui/icons'
import type { AppState } from '../../store'
import {
  getVideoAspectRatioLabel,
  getVideoResolutionLabel,
  normalizeVideoAspectRatio,
  normalizeVideoResolution,
} from '../../lib/video/videoCapabilities'
import type { TaskImageSource, TaskParams, TaskRecord } from '../../types'

export type DetailModalInfoPaneProps = {
  task: TaskRecord
  isVideoTask: boolean
  isAgentTask: boolean
  isAgentEditTool: boolean
  isFailedSlot: boolean
  outputLen: number
  showPendingPrompt: boolean
  showPromptWarning: boolean
  showRevisedPrompt: boolean
  currentRevisedPrompt: string | undefined
  showReferenceSection: boolean
  allInputImageIds: string[]
  maskTargetId: string | null
  maskPreviewSrc: string
  imageSrcs: Record<string, string>
  showSourceInfo: boolean
  taskProviderName: string
  taskUpstreamLabel: string
  taskProfileName: string
  taskModel: string
  taskSource: TaskImageSource
  currentActualParams: Partial<TaskParams> | undefined
  currentOutputImageId: string
  setDetailTaskId: AppState['setDetailTaskId']
  setLightboxImageId: AppState['setLightboxImageId']
  formatTime: (ts: number | null) => string
  formatDuration: () => string | null
  handleCopyPrompt: () => Promise<void>
  handleShowPromptWarning: () => void
  handleCopyInputImage: () => Promise<void>
  handleReuse: () => void
  handleEdit: () => void
  handleDelete: () => void
  handleToggleFavorite: () => void
}

export default function DetailModalInfoPane({
  task,
  isVideoTask,
  isAgentTask,
  isAgentEditTool,
  isFailedSlot,
  outputLen,
  showPendingPrompt,
  showPromptWarning,
  showRevisedPrompt,
  currentRevisedPrompt,
  showReferenceSection,
  allInputImageIds,
  maskTargetId,
  maskPreviewSrc,
  imageSrcs,
  showSourceInfo,
  taskProviderName,
  taskUpstreamLabel,
  taskProfileName,
  taskModel,
  taskSource,
  currentActualParams,
  currentOutputImageId,
  setDetailTaskId,
  setLightboxImageId,
  formatTime,
  formatDuration,
  handleCopyPrompt,
  handleShowPromptWarning,
  handleCopyInputImage,
  handleReuse,
  handleEdit,
  handleDelete,
  handleToggleFavorite,
}: DetailModalInfoPaneProps) {
  return (
        <div className="md:w-1/2 w-full flex-1 min-h-0 md:max-h-[90vh] md:flex-none p-5 overflow-y-auto overscroll-contain flex flex-col">
          <button
            onClick={() => setDetailTaskId(null)}
            className="absolute top-3 right-3 hidden p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400 z-10 md:block"
            aria-label="关闭"
          >
            <CloseIcon className="w-5 h-5" />
          </button>

          <div data-selectable-text className="flex-1">
            {task.status === 'done' && (task.failedImageCount ?? 0) > 0 && (
              <div className="mb-4 rounded-xl border border-amber-300/60 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-300">
                共 {outputLen + (task.failedImageCount ?? 0)} 张：成功 <span className="font-semibold">{outputLen}</span> 张 · 失败 <span className="font-semibold">{task.failedImageCount}</span> 张（翻到失败的那张可单独重试）
              </div>
            )}
            <div className="flex items-center gap-1.5 mb-2">
              <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                输入内容
              </h3>
              {task.prompt && !showPendingPrompt && (
                <button
                  onClick={handleCopyPrompt}
                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                  title="复制提示词"
                >
                  <CopyIcon className="h-4 w-4" />
                </button>
              )}
              {showPromptWarning && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className="p-1 rounded text-amber-500 hover:bg-amber-50 dark:text-yellow-300 dark:hover:bg-yellow-500/10 transition"
                    onClick={handleShowPromptWarning}
                    aria-label="提示词已被改写"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
            {showPendingPrompt ? (
              <div className="mb-4 leading-relaxed">
                <p className="text-sm text-gray-700 dark:text-gray-300">正在生成……</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">输入内容将在响应完成时接收</p>
              </div>
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">
                {task.prompt || '(无提示词)'}
              </p>
            )}
            {showRevisedPrompt && currentRevisedPrompt && (
              <div className="mb-4">
                <ActualValueBadge
                  value={currentRevisedPrompt}
                  className="max-w-full rounded px-2 py-1 text-left text-xs leading-relaxed whitespace-pre-wrap"
                />
              </div>
            )}

            {/* 参考图 */}
            {showReferenceSection && (
              <div className="mb-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                    参考图
                  </h3>
                  {allInputImageIds.length > 0 && (
                    <button
                      onClick={handleCopyInputImage}
                      className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                      title="复制参考图"
                    >
                      <CopyIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {allInputImageIds.length > 0 ? (
                  <>
                    <div className="flex gap-2 flex-wrap">
                      {allInputImageIds.map((imgId) => {
                        const isMaskTarget = imgId === maskTargetId
                        const displaySrc = (isMaskTarget && maskPreviewSrc) ? maskPreviewSrc : (imageSrcs[imgId] || '')
                        return (
                          <div key={imgId} className="relative group inline-block">
                            <div
                              className={`relative w-16 h-16 rounded-lg overflow-hidden border cursor-pointer hover:opacity-80 transition ${
                                isMaskTarget ? 'border-blue-500 border-2 shadow-sm' : 'border-gray-200 dark:border-white/[0.08]'
                              }`}
                              onClick={() => setLightboxImageId(imgId, allInputImageIds)}
                            >
                              {displaySrc && (
                                <img
                                  src={displaySrc}
                                  data-image-id={imgId}
                                  className="w-full h-full object-cover"
                                  alt=""
                                />
                              )}
                              {isMaskTarget && (
                                <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
                                  遮罩
                                </span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {isAgentEditTool && (
                      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        由模型自主选择，可能包含其他图片
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    由模型自主选择
                  </div>
                )}
              </div>
            )}

            {/* 参数 */}
            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              参数配置
            </h3>
            {showSourceInfo && (
              <div className="mb-2 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03]">
                <span className="text-gray-400 dark:text-gray-500">{isFailedSlot ? '失败来源' : '来源'}</span>
                <br />
                <span className="font-medium text-gray-700 dark:text-gray-200">{taskProviderName}</span>
                {taskUpstreamLabel && <span className="text-gray-400 dark:text-gray-500"> · {taskUpstreamLabel}</span>}
                <span className="text-gray-400 dark:text-gray-500"> · {taskProfileName} · </span>
                <span className="text-gray-400 dark:text-gray-500" title={taskSource.apiModel || undefined}>{taskModel}</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs mb-4">
              {isVideoTask ? (
                <>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">媒体</span>
                    <br />
                    <span className="font-medium text-gray-700 dark:text-gray-200">视频</span>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">时长</span>
                    <br />
                    <span className="font-medium text-gray-700 dark:text-gray-200">{task.videoDurationSeconds ?? '-'} 秒</span>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">比例</span>
                    <br />
                    <span className="font-medium text-gray-700 dark:text-gray-200">
                      {task.videoAspectRatio ? getVideoAspectRatioLabel(normalizeVideoAspectRatio(task.videoAspectRatio)) : '-'}
                    </span>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">分辨率</span>
                    <br />
                    <span className="font-medium text-gray-700 dark:text-gray-200">
                      {task.videoResolution ? getVideoResolutionLabel(normalizeVideoResolution(task.videoResolution)) : '-'}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">尺寸</span>
                    <br />
                    <DetailParamValue task={task} paramKey="size" className="font-medium" actualParams={currentActualParams} />
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">质量</span>
                    <br />
                    <DetailParamValue task={task} paramKey="quality" className="font-medium" actualParams={currentActualParams} />
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">格式</span>
                    <br />
                    <DetailParamValue task={task} paramKey="output_format" className="font-medium" actualParams={currentActualParams} />
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">审核</span>
                    <br />
                    <DetailParamValue task={task} paramKey="moderation" className="font-medium" actualParams={currentActualParams} />
                  </div>
                </>
              )}
              {!isVideoTask && !isAgentTask && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                  <span className="text-gray-400 dark:text-gray-500">数量</span>
                  <br />
                  <DetailParamValue task={task} paramKey="n" className="font-medium" />
                </div>
              )}
              {task.params.output_compression != null && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                  <span className="text-gray-400 dark:text-gray-500">压缩率</span>
                  <br />
                  <DetailParamValue task={task} paramKey="output_compression" className="font-medium" actualParams={currentActualParams} />
                </div>
              )}
            </div>

            {/* 时间 */}
            <div className="text-xs text-gray-400 dark:text-gray-500 mb-4">
              <span>创建于 {formatTime(task.createdAt)}</span>
              {formatDuration() && <span> · 耗时 {formatDuration()}</span>}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="grid grid-cols-4 sm:flex gap-2 pt-4 border-t border-gray-100 dark:border-white/[0.08]">
            <button
              onClick={handleReuse}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              复用配置
            </button>
            <button
              onClick={handleEdit}
              disabled={isVideoTask || !currentOutputImageId}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
            >
              <EditIcon className="w-4 h-4 flex-shrink-0" />
              编辑输出
            </button>
            <button
              onClick={handleDelete}
              className="col-span-3 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              <TrashIcon className="w-4 h-4 flex-shrink-0" />
              删除记录
            </button>
            <button
              onClick={handleToggleFavorite}
              className={`col-span-1 sm:flex-none sm:w-11 w-full flex items-center justify-center rounded-xl transition ${
                task.isFavorite
                  ? 'bg-yellow-50 text-yellow-500 hover:bg-yellow-100 dark:bg-yellow-500/10 dark:hover:bg-yellow-500/20'
                  : 'bg-gray-50 text-gray-400 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04] dark:hover:bg-yellow-500/10'
              }`}
              title={task.isFavorite ? '取消收藏' : '收藏记录'}
            >
              <svg className="w-5 h-5" fill={task.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </button>
          </div>
        </div>
  )
}
