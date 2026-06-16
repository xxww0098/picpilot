import type { TaskImageSource, TaskRecord } from '../types'
import { getCachedAuthUser } from '../lib/shared/auth'
import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  DEFAULT_VIDEO_MODEL,
  getActiveApiProfile,
} from '../lib/shared/apiProfiles'
import { putVideo as dbPutVideo, storeImage } from '../lib/shared/db'
import { logger, serializeError } from '../lib/shared/logger'
import { IMAGE_FETCH_CORS_HINT } from '../lib/image/imageApiShared'
import { replaceImageMentionsForApi } from '../lib/ui/promptImageMentions'
import { normalizeParamsForSettings } from '../lib/params/paramCompatibility'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import {
  getApiRequestNetworkErrorHint,
  getUpstreamApiErrorHint,
  isRecoverableConnectionError,
} from '../lib/task/taskErrorHints'
import { readBlobAsDataUrl } from '../lib/imaging/dataUrl'
import {
  firstActualParams,
  isAsyncCustomProviderTask,
  mapActualParamsByImage,
  putTask,
  readImageSizeParamsList,
} from '../lib/agent/taskPersistence'
import { generateVideo } from '../lib/server/videoApi'
import { applyTeamRuntimeSettings } from '../lib/config/runtimeTeamSettings'
import { cacheImage, ensureImageCached, evictCachedImage } from './imageCache'
import { genId, useStore } from './coreStore'
import {
  callImageApiWithStreamFallback,
  createSettingsForApiProfile,
  getFailedImageRetryProfile,
  getRawErrorPayload,
  getTaskApiProfile,
  imageSourcesFor,
  mergeImageSources,
  showCodexCliPrompt,
  sourceFromProfile,
  taskSourcePatchFromProfile,
  type ImageStreamFallbackContext,
} from './taskProfiles'
import {
  callImageApiPerInput,
  clearCustomRecoveryTimer,
  clearOpenAIWatchdogTimer,
  deleteUnreferencedImageIds,
  deleteUnreferencedVideoIds,
  getGalleryAutoRetryCount,
  getTaskAppMode,
  persistTaskStreamPartialImage,
  resolveImageApiFanoutConcurrency,
  scheduleCustomRecovery,
  scheduleOpenAIWatchdog,
  taskAbortControllers,
  updateTaskInStore,
} from './taskRuntime'

const failedImageRetryLocks = new Set<string>()

async function fetchUrlAsBlob(url: string, signal?: AbortSignal): Promise<Blob | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store', signal })
    if (!response.ok) return undefined
    return response.blob()
  } catch {
    return undefined
  }
}

async function fetchUrlAsDataUrl(url: string, signal?: AbortSignal): Promise<string | undefined> {
  const blob = await fetchUrlAsBlob(url, signal)
  if (!blob) return undefined
  return readBlobAsDataUrl(blob)
}

async function storeGeneratedVideo(opts: {
  videoUrl: string
  posterUrl?: string
  durationSeconds?: number
  signal?: AbortSignal
}) {
  const blob = await fetchUrlAsBlob(opts.videoUrl, opts.signal)
  const posterDataUrl = opts.posterUrl ? await fetchUrlAsDataUrl(opts.posterUrl, opts.signal) : undefined
  const id = genId()
  await dbPutVideo({
    id,
    blob,
    remoteUrl: opts.videoUrl,
    mime: blob?.type || 'video/mp4',
    posterDataUrl,
    durationSeconds: opts.durationSeconds,
    createdAt: Date.now(),
    source: 'generated',
  })
  return id
}

export async function executeVideoTask(taskId: string) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return
  const appMode = getTaskAppMode(task)

  const abortController = new AbortController()
  taskAbortControllers.set(taskId, abortController)

  try {
    logger.info('task', '视频任务开始执行', {
      appMode,
      taskId,
      model: task.apiModel,
      inputImages: task.inputImageIds.length,
      durationSeconds: task.videoDurationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS,
    })

    const inputDataUrls = await Promise.all(
      (task.inputImageIds || []).slice(0, 1).map(async (imgId) => {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('参考图片已不存在')
        return dataUrl
      }),
    )
    const result = await generateVideo({
      settings: applyTeamRuntimeSettings(useStore.getState().settings),
      model: DEFAULT_VIDEO_MODEL,
      prompt: replaceImageMentionsForApi(task.prompt, inputDataUrls.length),
      imageDataUrl: inputDataUrls[0],
      durationSeconds: task.videoDurationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS,
      pollTimeoutMs: Math.max(30, getCachedAuthUser()?.requestTimeoutSeconds ?? 900) * 1000,
      signal: abortController.signal,
    })

    const latestBeforeSuccess = useStore.getState().tasks.find((item) => item.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') return

    const videoId = await storeGeneratedVideo({
      videoUrl: result.videoUrl,
      posterUrl: result.posterUrl,
      durationSeconds: task.videoDurationSeconds,
      signal: abortController.signal,
    })

    const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      await deleteUnreferencedVideoIds([videoId])
      return
    }

    updateTaskInStore(taskId, {
      outputVideos: [videoId],
      rawImageUrls: [result.videoUrl],
      rawResponsePayload: result.rawPayload,
      status: 'done',
      error: null,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    logger.info('task', '视频任务完成', {
      appMode,
      taskId,
      model: task.apiModel,
      elapsedMs: Date.now() - task.createdAt,
    })
    useStore.getState().showToast('视频生成完成', 'success')
  } catch (err) {
    logger.error('task', '视频任务执行失败', {
      appMode,
      taskId,
      model: task.apiModel,
      elapsedMs: Date.now() - task.createdAt,
      error: serializeError(err),
    })
    const latestTask = useStore.getState().tasks.find((item) => item.id === taskId) ?? task
    if (latestTask.status !== 'running') return
    const isNetworkOrTimeout = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
    updateTaskInStore(taskId, {
      status: 'error',
      error: getUserFacingErrorMessage(err, '视频生成失败', { apiUpstream: !isNetworkOrTimeout }),
      ...getRawErrorPayload(err),
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    useStore.getState().setDetailTaskId(taskId)
  } finally {
    taskAbortControllers.delete(taskId)
    for (const imgId of task.inputImageIds) evictCachedImage(imgId)
  }
}

export async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: '找不到此任务所使用的 API 配置。',
      customRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    return
  }
  const activeProfile = taskProfile ?? getActiveApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = task.apiProvider ?? activeProfile.provider
  const appMode = getTaskAppMode(task)
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  if (!isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0)) {
    scheduleOpenAIWatchdog(taskId, activeProfile.timeout, activeProfile)
  }

  const abortController = new AbortController()
  taskAbortControllers.set(taskId, abortController)

  try {
    // 获取输入图片 data URLs（并行读取，Promise.all 保持顺序）
    const inputDataUrls = await Promise.all(
      task.inputImageIds.map(async (imgId) => {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        return dataUrl
      }),
    )
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    logger.info('task', '任务开始执行', {
      appMode,
      taskId,
      provider: taskProvider,
      profileName: activeProfile.name,
      model: activeProfile.model,
      apiMode: activeProfile.apiMode,
      edit: task.inputImageIds.length > 0,
      inputImages: task.inputImageIds.length,
      mask: Boolean(task.maskImageId),
      n: task.params.n,
      sourceMode: task.sourceMode,
    })

    const fanoutConcurrency = await resolveImageApiFanoutConcurrency()
    const onPartialImage = (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => {
      useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
      void persistTaskStreamPartialImage(taskId, partial.image)
    }
    let streamFallbackNotified = false
    const notifyStreamFallback = () => {
      if (streamFallbackNotified) return
      streamFallbackNotified = true
      useStore.getState().showToast('上游流式响应异常，正在关闭流式自动重试', 'info')
    }
    const streamFallback: ImageStreamFallbackContext = {
      profile: activeProfile,
      appMode,
      taskId,
      notify: notifyStreamFallback,
      detail: {
        action: 'generate',
      },
    }
    // 「每张」合并卡：按每张输入图各发一次请求，结果汇总到本卡（≥2 张输入才扇出；异步自定义服务商不走此路）。
    const usePerInput = Boolean(task.perInputImage) && inputDataUrls.length > 1
    const result = usePerInput
      ? await callImageApiPerInput(
          {
            settings: requestSettings,
            // 每次请求只带 1 张输入图，提示词 @图N 按单图解析，与旧的「每张一卡」行为一致
            prompt: replaceImageMentionsForApi(task.prompt, 1),
            params: task.params,
            telemetry: {
              actionType: 'generate',
              appMode,
              taskId,
            },
            signal: abortController.signal,
            fanoutConcurrency,
          },
          inputDataUrls,
          task.params.n > 0 ? task.params.n : 1,
          onPartialImage,
          streamFallback,
        )
      : await callImageApiWithStreamFallback({
          settings: requestSettings,
          prompt: replaceImageMentionsForApi(task.prompt, inputDataUrls.length),
          params: task.params,
          telemetry: {
            actionType: 'generate',
            appMode,
            taskId,
          },
          inputImageDataUrls: inputDataUrls,
          maskDataUrl,
          onCustomTaskEnqueued: (request) => {
            customTaskInfo = request
            updateTaskInStore(taskId, {
              customTaskId: request.taskId,
              customRecoverable: false,
            })
          },
          onPartialImage,
          signal: abortController.signal,
          fanoutConcurrency,
        }, streamFallback)

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const outputIds: string[] = []
    for (const dataUrl of result.images) {
      const imgId = await storeImage(dataUrl, 'generated')
      cacheImage(imgId, dataUrl)
      outputIds.push(imgId)
    }
    const isAsyncCustomTask = taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = isAsyncCustomTask
      ? await readImageSizeParamsList(result.images)
      : result.actualParamsList
    const actualParams = isAsyncCustomTask
      ? firstActualParams(actualParamsList)
      : { ...result.actualParams, n: outputIds.length }
    const shouldStoreRevisedPrompts = !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPromptByImage = shouldStoreRevisedPrompts ? result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
      const imgId = outputIds[index]
      if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
      return acc
    }, {}) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && result.revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== task.prompt.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && result.revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    const failedImageCount = result.failedCount && result.failedCount > 0 ? result.failedCount : 0
    const taskImageSource = sourceFromProfile(activeProfile)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      sourceByImage: imageSourcesFor(outputIds, taskImageSource),
      failedImageCount: failedImageCount > 0 ? failedImageCount : undefined,
      failedImageSource: failedImageCount > 0 ? taskImageSource : undefined,
      partialImageErrors: failedImageCount > 0 && result.failedErrors?.length ? result.failedErrors : undefined,
      status: 'done',
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
      customRecoverable: false,
    })
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    logger.info('task', '任务完成', {
      appMode,
      taskId,
      provider: taskProvider,
      images: outputIds.length,
      elapsedMs: Date.now() - task.createdAt,
    })
    useStore.getState().showToast(
      failedImageCount > 0
        ? `生成完成：成功 ${outputIds.length} 张，失败 ${failedImageCount} 张`
        : `生成完成，共 ${outputIds.length} 张图片`,
      failedImageCount > 0 ? 'info' : 'success',
    )
    if (failedImageCount > 0) {
      await autoRetryFailedImages(taskId, getGalleryAutoRetryCount())
    }
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    clearOpenAIWatchdogTimer(taskId)
    logger.error('task', '任务执行失败', {
      appMode,
      taskId,
      provider: task.apiProvider,
      model: task.apiModel,
      apiMode: task.apiMode,
      elapsedMs: Date.now() - task.createdAt,
      error: serializeError(err),
    })
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId) ?? task
    if (latestTask.status !== 'running') return
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestCustomTaskInfo && isRecoverableConnectionError(err)) {
      updateTaskInStore(taskId, {
        status: 'error',
        error: '与自定义异步任务的连接已断开，之后会继续查询任务结果。',
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const settings = useStore.getState().settings
      const profile = getTaskApiProfile(settings, latestTask)
      const usesApiProxy = true
      const activeProfile = getActiveApiProfile(settings)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfile.provider,
        apiMode: settings.apiMode,
        streamImages: activeProfile.streamImages,
        streamPartialImages: activeProfile.streamPartialImages,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, latestTask.createdAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      } else {
        const upstreamHint = getUpstreamApiErrorHint(err)
        if (upstreamHint) errorMessage += `\n${upstreamHint}`
      }
      const isNetworkOrTimeout = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
      errorMessage = getUserFacingErrorMessage(errorMessage, '生成失败', { apiUpstream: !isNetworkOrTimeout })
      updateTaskInStore(taskId, {
        status: 'error',
        error: errorMessage,
        ...getRawErrorPayload(err),
        customRecoverable: false,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      useStore.getState().setDetailTaskId(taskId)
    }
  } finally {
    taskAbortControllers.delete(taskId)
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      evictCachedImage(imgId)
    }
  }
}

// 用户主动取消执行中的任务：中止底层请求（服务端收到 abort 返回 499 并释放并发槽位），
// 并同步置为「已停止」终态。因在 fetch 拒绝之前就写入 'error'，executeTask 的 catch 守卫
// （latestTask.status !== 'running' → return）会据此抑制误报的错误 toast / 详情弹窗。
export function cancelTask(taskId: string) {
  const controller = taskAbortControllers.get(taskId)
  controller?.abort()
  taskAbortControllers.delete(taskId)
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task || task.status !== 'running') return
  clearOpenAIWatchdogTimer(taskId)
  clearCustomRecoveryTimer(taskId)
  useStore.getState().setTaskStreamPreview(taskId)
  updateTaskInStore(taskId, {
    status: 'error',
    error: '已停止生成。',
    customRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast('已停止生成', 'info')
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  const { settings } = useStore.getState()
  const activeProfile = getActiveApiProfile(settings)
  const normalizedParams = normalizeParamsForSettings(task.params, settings, {
    hasInputImages: task.inputImageIds.length > 0,
    maxOutputImages: getCachedAuthUser()?.maxBatchImages,
  })
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: normalizedParams,
    ...taskSourcePatchFromProfile(activeProfile),
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    outputImages: [],
    ...(task.mediaType === 'video'
      ? {
          apiProvider: 'xAI',
          apiProfileId: undefined,
          apiProfileName: 'xAI Imagine',
          apiMode: 'images' as const,
          apiModel: task.apiModel || DEFAULT_VIDEO_MODEL,
          upstreamMode: undefined,
          mediaType: 'video' as const,
          outputVideos: [],
          videoDurationSeconds: task.videoDurationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS,
        }
      : {}),
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    sourceMode: task.mediaType === 'video' ? 'video' : task.sourceMode,
    ...(task.perInputImage ? { perInputImage: true } : {}),
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  if (newTask.mediaType === 'video') executeVideoTask(taskId)
  else executeTask(taskId)
}

/**
 * 就地重试：在原失败卡片上直接重跑，复用同一个 task id，不新建卡片。
 * 把卡片从 error 切回 running，清掉上一次的输出/报错/中间态，再重新执行。
 * 状态完全由该 task 自身的 status 驱动，因此天然按卡片隔离，不会牵连其他卡片。
 */
export async function retryTaskInPlace(taskId: string) {
  const state = useStore.getState()
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task || task.status === 'running') return

  // 中止可能残留的旧请求 / 计时器，避免就地重试后状态被旧回调污染
  taskAbortControllers.get(taskId)?.abort()
  taskAbortControllers.delete(taskId)
  clearOpenAIWatchdogTimer(taskId)
  clearCustomRecoveryTimer(taskId)
  state.setTaskStreamPreview(taskId)

  const { settings } = state
  const activeProfile = getActiveApiProfile(settings)
  const normalizedParams = normalizeParamsForSettings(task.params, settings, {
    hasInputImages: task.inputImageIds.length > 0,
    maxOutputImages: getCachedAuthUser()?.maxBatchImages,
  })

  updateTaskInStore(taskId, {
    params: normalizedParams,
    ...taskSourcePatchFromProfile(activeProfile),
    ...(task.mediaType === 'video'
      ? {
          apiProvider: 'xAI',
          apiProfileId: undefined,
          apiProfileName: 'xAI Imagine',
          apiMode: 'images' as const,
          apiModel: task.apiModel || DEFAULT_VIDEO_MODEL,
          upstreamMode: undefined,
          mediaType: 'video' as const,
          outputVideos: [],
          videoDurationSeconds: task.videoDurationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS,
        }
      : {}),
    outputImages: [],
    streamPartialImageIds: undefined,
    rawImageUrls: undefined,
    rawResponsePayload: undefined,
    actualParams: undefined,
    actualParamsByImage: undefined,
    revisedPromptByImage: undefined,
    sourceByImage: undefined,
    failedImageCount: undefined,
    failedImageSource: undefined,
    partialImageErrors: undefined,
    customTaskId: undefined,
    customRecoverable: false,
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  })

  if (task.mediaType === 'video') executeVideoTask(taskId)
  else executeTask(taskId)
}

type RetryFailedImagesResult = { added: number; stillFailed: number }

async function autoRetryFailedImages(taskId: string, maxAttempts: number): Promise<void> {
  const attempts = Math.max(0, Math.min(5, Math.trunc(maxAttempts)))
  if (attempts <= 0) return

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const latest = useStore.getState().tasks.find((t) => t.id === taskId)
    const failedCount = latest?.failedImageCount ?? 0
    if (!latest || latest.status !== 'done' || failedCount <= 0 || latest.perInputImage) return

    useStore.getState().showToast(`有 ${failedCount} 张失败，正在自动重试（${attempt}/${attempts}）`, 'info')
    try {
      const result = await retryFailedImages(taskId, { silent: true })
      if (!result) return
      if (result.stillFailed <= 0) {
        useStore.getState().showToast(`自动重试已补齐失败的 ${result.added} 张图片`, 'success')
        return
      }
    } catch (err) {
      const isNetworkOrTimeout = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
      const message = getUserFacingErrorMessage(err, '自动重试失败', { apiUpstream: !isNetworkOrTimeout })
      const task = useStore.getState().tasks.find((t) => t.id === taskId)
      logger.error('task', '自动重试失败图片出错', {
        appMode: task ? getTaskAppMode(task) : 'gallery',
        taskId,
        attempt,
        error: serializeError(err),
      })
      useStore.getState().showToast(`自动重试失败：${message}`, 'error')
      return
    }
  }

  const latest = useStore.getState().tasks.find((t) => t.id === taskId)
  const stillFailed = latest?.failedImageCount ?? 0
  if (stillFailed > 0) {
    useStore.getState().showToast(`自动重试结束，仍有 ${stillFailed} 张失败，可在详情中手动重试`, 'info')
  }
}

/**
 * 只重试批量任务里失败的那几张：按原请求 n 的缺口数重新请求，成功的追加到 outputImages，
 * 并据返回的失败数更新 failedImageCount。不新建任务，直接补齐当前任务。
 */
export async function retryFailedImages(taskId: string, options: { silent?: boolean } = {}): Promise<RetryFailedImagesResult | null> {
  if (failedImageRetryLocks.has(taskId)) {
    if (!options.silent) useStore.getState().showToast('这组图片正在重试失败图片，请稍候', 'info')
    return null
  }
  failedImageRetryLocks.add(taskId)

  let retrySlotIndex = -1
  let markedRegenerating = false
  let retryFailureSource: TaskImageSource | null = null

  try {
    const state = useStore.getState()
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return null
    const appMode = getTaskAppMode(task)
    const failedCount = task.failedImageCount ?? 0
    if (failedCount <= 0) return null

    // 「每张」合并卡不追踪具体哪张输入图失败，无法只补失败槽位（按 n=失败数 重发会变成合成语义），整卡重跑。
    if (task.perInputImage) {
      if (options.silent) return null
      await retryTaskInPlace(taskId)
      return null
    }

    const runningImageIndex = useStore.getState().regeneratingImageSlots[taskId]
    if (runningImageIndex != null) {
      if (!options.silent) {
        state.showToast(`第 ${runningImageIndex + 1} 张图片正在重新生成，请稍候`, 'info')
      }
      return null
    }

    const { settings } = state
    const profile = getFailedImageRetryProfile(settings, task)
    const requestSettings = createSettingsForApiProfile(settings, profile)
    retryFailureSource = sourceFromProfile(profile)
    retrySlotIndex = task.outputImages.length
    const requestedOutputCount = Number.isFinite(task.params.n) && task.params.n > 0 ? Math.trunc(task.params.n) : task.outputImages.length + failedCount
    const targetOutputCount = Math.max(1, requestedOutputCount)
    const missingOutputCount = Math.max(0, targetOutputCount - task.outputImages.length)
    const requestCount = Math.min(failedCount, missingOutputCount)
    if (requestCount <= 0) {
      updateTaskInStore(taskId, {
        failedImageCount: undefined,
        failedImageSource: undefined,
        partialImageErrors: undefined,
        actualParams: { ...task.actualParams, n: task.outputImages.length },
      })
      if (!options.silent) {
        state.showToast(`这组图片已有 ${task.outputImages.length} 张，已达到或超过目标数量 ${targetOutputCount} 张`, 'info')
      }
      logger.warn('task', '重试失败图片跳过：当前输出已达到目标数量', {
        appMode,
        taskId,
        failedCount,
        targetOutputCount,
        currentOutputCount: task.outputImages.length,
      })
      return { added: 0, stillFailed: 0 }
    }

    const retryLabel = requestCount > 1
      ? `正在重试 ${requestCount} 张失败图片`
      : `正在重试第 ${retrySlotIndex + 1} 张`

    useStore.getState().setRegeneratingImageSlot(taskId, retrySlotIndex, retryLabel)
    markedRegenerating = true
    if (!options.silent) {
      state.showToast(`已开始重试 ${requestCount} 张失败图片`, 'info')
    }

    const inputDataUrls = await Promise.all(
      task.inputImageIds.map(async (imgId) => {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        return dataUrl
      }),
    )
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    logger.info('task', '重试失败图片', {
      appMode,
      taskId,
      retryCount: requestCount,
      failedCount,
      targetOutputCount,
      currentOutputCount: task.outputImages.length,
      provider: task.apiProvider,
    })

    const fanoutConcurrency = await resolveImageApiFanoutConcurrency()
    const result = await callImageApiWithStreamFallback({
      settings: requestSettings,
      prompt: replaceImageMentionsForApi(task.prompt, inputDataUrls.length),
      params: { ...task.params, n: requestCount },
      telemetry: {
        actionType: options.silent ? 'auto_retry_failed_images' : 'retry_failed_images',
        appMode,
        taskId,
        awaitReport: true,
      },
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
      fanoutConcurrency,
    }, {
      profile,
      appMode,
      taskId,
      notify: options.silent ? undefined : () => state.showToast('上游流式响应断开，正在关闭流式重试失败图片', 'info'),
      detail: {
        action: options.silent ? 'auto_retry_failed_images' : 'retry_failed_images',
        retryCount: requestCount,
      },
    })

    const latest = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latest) return null

    const newIds: string[] = []
    for (const dataUrl of result.images) {
      const imgId = await storeImage(dataUrl, 'generated')
      cacheImage(imgId, dataUrl)
      newIds.push(imgId)
    }

    const stillFailed = Math.max(0, targetOutputCount - latest.outputImages.length - newIds.length)
    const mergedOutput = [...latest.outputImages, ...newIds]
    const retrySource = retryFailureSource ?? sourceFromProfile(profile)
    updateTaskInStore(taskId, {
      outputImages: mergedOutput,
      failedImageCount: stillFailed > 0 ? stillFailed : undefined,
      failedImageSource: stillFailed > 0 ? retrySource : undefined,
      partialImageErrors: stillFailed > 0 ? (result.failedErrors?.length ? result.failedErrors : latest.partialImageErrors) : undefined,
      actualParams: { ...latest.actualParams, n: mergedOutput.length },
      sourceByImage: mergeImageSources(latest.sourceByImage, newIds, retrySource),
      ...(latest.outputImages.length === 0 ? taskSourcePatchFromProfile(profile) : {}),
    })

    logger.info('task', '重试失败图片完成', {
      appMode,
      taskId,
      added: newIds.length,
      stillFailed,
      targetOutputCount,
      requested: requestCount,
      returned: result.images.length,
    })
    if (!options.silent) {
      state.showToast(
        stillFailed > 0
          ? `已重试：成功 ${newIds.length} 张，仍有 ${stillFailed} 张失败`
          : `已补齐失败的 ${newIds.length} 张图片`,
        stillFailed > 0 ? 'info' : 'success',
      )
    }
    return { added: newIds.length, stillFailed }
  } catch (err) {
    if (options.silent) throw err
    const isNetworkOrTimeout = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
    const message = getUserFacingErrorMessage(err, '重试失败', { apiUpstream: !isNetworkOrTimeout })
    const task = useStore.getState().tasks.find((t) => t.id === taskId)
    logger.error('task', '重试失败图片出错', { appMode: task ? getTaskAppMode(task) : 'gallery', taskId, error: serializeError(err) })
    if (task && (task.failedImageCount ?? 0) > 0 && retryFailureSource) {
      updateTaskInStore(taskId, { failedImageSource: retryFailureSource })
    }
    useStore.getState().showToast(`重试失败：${message}`, 'error')
    return null
  } finally {
    failedImageRetryLocks.delete(taskId)
    if (markedRegenerating && retrySlotIndex >= 0 && useStore.getState().regeneratingImageSlots[taskId] === retrySlotIndex) {
      useStore.getState().setRegeneratingImageSlot(taskId, null)
    }
  }
}
