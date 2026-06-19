import type { AppMode, StoredImage, TaskRecord } from '../types'
import { getCachedAuthUser } from '../lib/shared/auth'
import { fetchQueueStats } from '../lib/server/queueApi'
import { deleteImage, deleteVideo, evictOldestImages, getAllImageIds, isQuotaExceededError, storeImage, StorageFullError } from '../lib/shared/db'
import { callImageApi, type CallApiOptions, type CallApiResult } from '../lib/image/api'
import { logger, serializeError } from '../lib/shared/logger'
import { getImageApiFanoutConcurrency } from '../lib/image/imageApiShared'
import { applyTeamRuntimeSettings } from '../lib/config/runtimeTeamSettings'
import { getActiveApiProfile } from '../lib/shared/apiProfiles'
import { buildImageGenerationTelemetryBase, reportImageGenerationPersistOutcome } from '../lib/image/imageTelemetry'
import { settleWithConcurrency } from '../lib/shared/runWithConcurrency'
import { getCustomQueuedImageResult } from '../lib/image/openaiCompatibleImageApi'
import { getCustomProviderDefinition } from '../lib/shared/apiProfiles'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import { createOpenAITimeoutError, type TimeoutStreamingHintProfile } from '../lib/task/taskErrorHints'
import {
  firstActualParams,
  isRunningOpenAITask,
  mapActualParamsByImage,
  putTask,
  readImageSizeParamsList,
} from '../lib/agent/taskPersistence'
import { cacheImage, evictCachedImage } from './imageCache'
import type { AgentInputDraft } from './appState'
import { useStore } from './coreStore'
import {
  callImageApiWithStreamFallback,
  getCustomRecoveryProfile,
  getRawErrorPayload,
  type ImageStreamFallbackContext,
} from './taskProfiles'

const CUSTOM_RECOVERY_POLL_MS = 10_000
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const OPENAI_INTERRUPTED_ERROR = '请求中断'

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now = Date.now()) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    if (!isRunningOpenAITask(task) || task.customTaskId) return task

    const updated: TaskRecord = {
      ...task,
      status: 'error',
      error: OPENAI_INTERRUPTED_ERROR,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

export function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    status: 'error',
    error,
    finishedAt: now,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

// 看门狗在「每请求超时」之上再留一段缓冲：让每个并发请求按自身超时结束、
// callImageApi 返回部分成功结果并由 executeTask 落库后，再考虑兜底失败，
// 避免批量生成里 1 张卡住时把已成功的图一起判失败丢弃。
const OPENAI_WATCHDOG_BUFFER_MS = 60_000

export function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000) + OPENAI_WATCHDOG_BUFFER_MS
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

export function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

export function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

export function addAgentReferencedImageIds(target: Set<string>, conversations = useStore.getState().agentConversations, inputDrafts = useStore.getState().agentInputDrafts) {
  for (const conversation of conversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) target.add(id)
      if (round.maskImageId) target.add(round.maskImageId)
    }
    for (const message of conversation.messages) {
      if (message.maskImageId) target.add(message.maskImageId)
    }
  }
  for (const draft of Object.values(inputDrafts)) {
    for (const img of draft.inputImages) target.add(img.id)
  }
}

export function addInputDraftReferencedImageIds(target: Set<string>, draft: AgentInputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) target.add(img.id)
}

export function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

export function addTaskReferencedVideoIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.outputVideos || []) target.add(id)
}

export function replaceImageKeyedValue<T>(
  source: Record<string, T> | undefined,
  oldImageId: string,
  newImageId: string,
  value: T | undefined,
): Record<string, T> | undefined {
  const next: Record<string, T> = {}
  for (const [imageId, item] of Object.entries(source ?? {})) {
    if (imageId !== oldImageId) next[imageId] = item
  }
  if (value !== undefined) next[newImageId] = value
  return Object.keys(next).length ? next : undefined
}

export function replaceRawImageUrl(
  rawImageUrls: string[] | undefined,
  outputImageCount: number,
  imageIndex: number,
  nextRawImageUrl: string | undefined,
): string[] | undefined {
  const normalizedUrl = nextRawImageUrl?.trim()
  if (!rawImageUrls?.length) return normalizedUrl ? [normalizedUrl] : undefined

  if (rawImageUrls.length === outputImageCount) {
    const next = [...rawImageUrls]
    if (normalizedUrl) next[imageIndex] = normalizedUrl
    else next.splice(imageIndex, 1)
    return next.length ? next : undefined
  }

  return normalizedUrl ? [...rawImageUrls, normalizedUrl] : rawImageUrls
}

export async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, inputImages, galleryInputDraft } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  for (const imgId of candidates) {
    if (stillUsed.has(imgId)) continue
    await deleteImage(imgId)
    evictCachedImage(imgId)
  }
}

/**
 * Persist a generated image, reclaiming IndexedDB space if the store is full.
 *
 * Without this wrapper a `QuotaExceededError` would bubble up from `storeImage`
 * and the caller would treat it as a generation failure — even though the image
 * was already produced upstream (credit spent). Instead we:
 *   1. try to save normally;
 *   2. on quota error, delete orphaned images (no task/draft references) and retry;
 *   3. still full — evict the oldest images by createdAt and retry;
 *   4. still full — throw {@link StorageFullError} so the caller can keep the
 *      generated image in memory and tell the user "storage full" rather than
 *      "generation failed".
 *
 * The eviction batches are best-effort; victims also get purged from the
 * in-memory image cache. Only `source === 'generated'` paths need reclaim;
 * uploads/masks are small, but the wrapper is safe for all sources.
 */

/** Number of oldest images dropped in one reclaim batch. */
const EVICT_BATCH_SIZE = 8

export async function storeImageWithReclaim(
  dataUrl: string,
  source: NonNullable<StoredImage['source']> = 'generated',
): Promise<string> {
  try {
    return await storeImage(dataUrl, source)
  } catch (err) {
    if (!isQuotaExceededError(err)) throw err
    logger.warn('taskRuntime', 'IndexedDB 配额不足，开始清理孤儿图片后重试', { source })
  }

  // Reclaim pass 1: orphaned images (no task/draft/input references).
  try {
    const allIds = await getAllImageIds()
    await deleteUnreferencedImageIds(allIds)
    return await storeImage(dataUrl, source)
  } catch (err) {
    if (!isQuotaExceededError(err)) throw err
    logger.warn('taskRuntime', '清理孤儿后仍不足，开始淘汰最旧图片后重试', { source })
  }

  // Reclaim pass 2: evict the oldest images regardless of references.
  try {
    const evicted = await evictOldestImages(EVICT_BATCH_SIZE)
    for (const id of evicted) evictCachedImage(id)
    return await storeImage(dataUrl, source)
  } catch (err) {
    if (!isQuotaExceededError(err)) throw err
    logger.error('taskRuntime', '淘汰最旧图片后仍无法保存，存储已满', { source })
  }

  throw new StorageFullError()
}

export async function deleteUnreferencedVideoIds(videoIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(videoIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedVideoIds(stillUsed, task)

  for (const videoId of candidates) {
    if (stillUsed.has(videoId)) continue
    await deleteVideo(videoId)
  }
}

export async function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  try {
    const imgId = await storeImageWithReclaim(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)

    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done') {
      await deleteUnreferencedImageIds([imgId])
      return
    }

    const currentIds = latestTask.streamPartialImageIds || []
    if (currentIds.includes(imgId)) return
    updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imgId] })
  } catch (err) {
    logger.error('task', '流式部分图片处理出错', { taskId, error: serializeError(err) })
  }
}

// 每个执行中任务的取消控制器；cancelTask 通过它中止底层 fetch（服务端收到 abort 返回 499 释放槽位）。
export const taskAbortControllers = new Map<string, AbortController>()

export async function resolveImageApiFanoutConcurrency(): Promise<number> {
  const fallbackMaxConcurrent = getCachedAuthUser()?.maxConcurrent
  try {
    const stats = await fetchQueueStats()
    useStore.getState().setQueueStats(stats)
    return getImageApiFanoutConcurrency(stats)
  } catch {
    return getImageApiFanoutConcurrency({ maxConcurrent: fallbackMaxConcurrent })
  }
}

export function getGalleryAutoRetryCount(): number {
  const count = getCachedAuthUser()?.galleryAutoRetryCount ?? 1
  return Number.isFinite(count) ? Math.max(0, Math.min(5, Math.trunc(count))) : 1
}

type TaskAppModeSource = Pick<
  TaskRecord,
  'mediaType' | 'sourceMode' | 'agentConversationId' | 'agentRoundId' | 'agentMessageId' | 'agentToolCallId'
>

export function getTaskAppMode(task: TaskAppModeSource): AppMode {
  if (task.mediaType === 'video' || task.sourceMode === 'video') return 'video'
  if (task.sourceMode === 'agent' || task.agentConversationId || task.agentRoundId || task.agentMessageId || task.agentToolCallId) return 'agent'
  return 'gallery'
}

// 多图「每张」合并卡的执行：按每张输入图各发一次请求，汇总成一个 CallApiResult。
// 输出顺序 = 输入图顺序；图片/实际参数/改写提示词按输出顺序对齐；任一输入失败计入 failedCount（每输入占 perInputCount 张）。
// 流式预览槽位按 inputIndex * perInputCount 偏移，避免不同输入的中间帧互相覆盖。
export async function callImageApiPerInput(
  baseOpts: Omit<CallApiOptions, 'inputImageDataUrls' | 'onPartialImage' | 'maskDataUrl' | 'onCustomTaskEnqueued'>,
  inputDataUrls: string[],
  perInputCount: number,
  onPartialImage?: CallApiOptions['onPartialImage'],
  streamFallback?: ImageStreamFallbackContext,
): Promise<CallApiResult> {
  const results = await settleWithConcurrency(
    inputDataUrls,
    baseOpts.fanoutConcurrency ?? getImageApiFanoutConcurrency(),
    (dataUrl, inputIndex) => {
      const childTelemetry = baseOpts.telemetry
        ? { ...baseOpts.telemetry, deferSuccessTelemetry: true }
        : undefined
      const opts: CallApiOptions = {
        ...baseOpts,
        telemetry: childTelemetry,
        inputImageDataUrls: [dataUrl],
        onPartialImage: onPartialImage
          ? (partial) => onPartialImage({ ...partial, requestIndex: inputIndex * perInputCount + (partial.requestIndex ?? 0) })
          : undefined,
      }
      return streamFallback
        ? callImageApiWithStreamFallback(opts, {
            ...streamFallback,
            detail: {
              ...streamFallback.detail,
              inputIndex,
            },
          })
        : callImageApi(opts)
    },
  )
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled').map((r) => r.value)
  if (fulfilled.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    throw firstError ? firstError.reason : new Error('所有参考图请求均失败')
  }
  const images = fulfilled.flatMap((r) => r.images)
  const actualParamsList = fulfilled.flatMap((r) => (r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams)))
  const revisedPrompts = fulfilled.flatMap((r) => (r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined)))
  const rawImageUrls = fulfilled.flatMap((r) => r.rawImageUrls ?? [])
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  const failedCount = rejected.length * perInputCount
  const failedErrors = rejected.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
  const merged: CallApiResult = {
    images,
    actualParams: fulfilled[0]?.actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(failedCount ? { failedCount, failedErrors } : {}),
  }
  if (baseOpts.telemetry?.deferSuccessTelemetry) {
    const effectiveSettings = applyTeamRuntimeSettings(baseOpts.settings)
    const profile = getActiveApiProfile(effectiveSettings)
    const appMode = baseOpts.telemetry.appMode ?? 'gallery'
    const telemetryBase = buildImageGenerationTelemetryBase({
      profile,
      appMode,
      prompt: baseOpts.prompt,
      params: baseOpts.params,
      inputImageCount: inputDataUrls.length,
      hasMask: false,
      actionType: baseOpts.telemetry.actionType ?? 'generate',
      taskId: baseOpts.telemetry.taskId,
      imageIndex: baseOpts.telemetry.imageIndex,
    })
    merged.reportPersistOutcome = (outcome, opts) =>
      reportImageGenerationPersistOutcome(telemetryBase, outcome, {
        durationMs: opts?.durationMs ?? 0,
        images: opts?.images ?? merged.images,
        err: opts?.err,
        awaitReport: baseOpts.telemetry?.awaitReport,
      })
  }
  return merged
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const actualParamsList = await readImageSizeParamsList(result.images)
  const outputIds: string[] = []
  for (const dataUrl of result.images) {
    const imgId = await storeImageWithReclaim(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)
    outputIds.push(imgId)
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    customRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = task.apiProvider ? getCustomProviderDefinition(settings, task.apiProvider) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: getUserFacingErrorMessage(err, '自定义任务恢复失败', { apiUpstream: true }),
      ...getRawErrorPayload(err),
      customRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}
