import type { MultiImageMode, TaskRecord } from '../types'
import { getCachedAuthUser } from '../lib/shared/auth'
import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  DEFAULT_VIDEO_MODEL,
  getActiveApiProfile,
  normalizeSettings,
  normalizeVideoDurationSeconds,
  validateApiProfile,
} from '../lib/shared/apiProfiles'
import { storeImage } from '../lib/shared/db'
import { validateMaskMatchesImage } from '../lib/imaging/canvasImage'
import { orderInputImagesForMask } from '../lib/imaging/mask'
import { getChangedParams, normalizeParamsForSettings } from '../lib/params/paramCompatibility'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import { putTask } from '../lib/agent/taskPersistence'
import { applyTeamRuntimeSettings } from '../lib/config/runtimeTeamSettings'
import { cacheImage } from './imageCache'
import { genId, useStore } from './coreStore'
import {
  createSettingsForApiProfile,
  getReusedTaskApiProfile,
  taskSourcePatchFromProfile,
} from './taskProfiles'
import { executeTask, executeVideoTask } from './taskExecution'

function splitBatchPromptDraft(prompt: string): string[] {
  const parts = prompt
    .split(/\n\s*---+\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : [prompt.trim()].filter(Boolean)
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean; multiImageMode?: MultiImageMode } = {}) {
  const { appMode, settings, prompt, inputImages, maskDraft, params, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, showToast, setConfirmDialog } =
    useStore.getState()

  const normalizedSettings = applyTeamRuntimeSettings(normalizeSettings(settings))
  let activeProfile = getActiveApiProfile(normalizedSettings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
      },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  const apiProfileError = validateApiProfile(activeProfile)
  if (apiProfileError) {
    showToast(`API 配置未完成：${apiProfileError}`, 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ ...options, allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(getUserFacingErrorMessage(err, '遮罩图片无效'), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）；并行写入，按 hash 去重
  await Promise.all(orderedInputImages.map((img) => storeImage(img.dataUrl)))

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, {
    hasInputImages: orderedInputImages.length > 0,
    maxOutputImages: getCachedAuthUser()?.maxBatchImages,
  })
  const normalizedParamPatch = getChangedParams(params, normalizedParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const trimmedPrompt = prompt.trim()
  const promptDrafts = appMode === 'gallery' ? splitBatchPromptDraft(trimmedPrompt) : [trimmedPrompt]
  const createdAt = Date.now()
  // 多图模式：each=每张参考图各生成一组（N 张输入 → N 组结果）；merge=合成为一次请求（N→1）。
  // 有遮罩时只能合成（遮罩针对单张目标图）；单张/无图时两种模式等价。
  // each 模式现在不再拆成 N 张卡，而是建 1 张「合并卡」（perInputImage），执行时按每张输入图扇出、结果汇总到本卡。
  const effectiveMode = options.multiImageMode ?? normalizedSettings.multiImageMode
  const perInputImage = effectiveMode === 'each' && !maskDraft && orderedInputImages.length >= 2

  const makeTask = (promptText: string, inputImageIds: string[], taskMaskImageId: string | null, taskMaskTargetImageId: string | null, isPerInputImage: boolean): TaskRecord => ({
    id: genId(),
    prompt: promptText,
    params: normalizedParams,
    ...taskSourcePatchFromProfile(activeProfile),
    inputImageIds,
    maskTargetImageId: taskMaskTargetImageId,
    maskImageId: taskMaskImageId,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt,
    finishedAt: null,
    elapsed: null,
    ...(isPerInputImage ? { perInputImage: true } : {}),
  })

  // perInputImage 时无遮罩（!maskDraft 守卫），故 maskImageId/maskTargetImageId 此时本就为 null。
  const newTasks: TaskRecord[] = promptDrafts.map((promptText) =>
    makeTask(promptText, orderedInputImages.map((i) => i.id), maskImageId, maskTargetImageId, perInputImage),
  )

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([...newTasks, ...latestTasks])
  await Promise.all(newTasks.map((t) => putTask(t)))
  useStore.getState().showToast(
    promptDrafts.length > 1
      ? `已提交 ${promptDrafts.length} 条批量草稿`
      : perInputImage
      ? `已提交：将为 ${orderedInputImages.length} 张参考图各生成一组`
      : '任务已提交',
    'success',
  )

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)

  // 异步调用 API（逐个任务独立执行，由全局并发队列节流）
  for (const t of newTasks) executeTask(t.id)
}

export async function submitVideoTask() {
  const state = useStore.getState()
  const { prompt, inputImages, maskDraft, settings, showToast } = state
  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }
  if (maskDraft) {
    showToast('视频模式暂不支持遮罩，请先移除遮罩。', 'error')
    return
  }
  await Promise.all(inputImages.map((img) => storeImage(img.dataUrl)))

  const durationSeconds = normalizeVideoDurationSeconds(settings.videoDurationSeconds, DEFAULT_VIDEO_DURATION_SECONDS)
  const task: TaskRecord = {
    id: genId(),
    prompt: prompt.trim(),
    params: { ...state.params, n: 1 },
    apiProvider: 'xAI',
    apiProfileName: 'xAI Imagine',
    apiMode: 'images',
    apiModel: DEFAULT_VIDEO_MODEL,
    inputImageIds: inputImages.slice(0, 1).map((img) => img.id),
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    mediaType: 'video',
    outputVideos: [],
    videoDurationSeconds: durationSeconds,
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    sourceMode: 'video',
  }

  useStore.getState().setTasks([task, ...useStore.getState().tasks])
  await putTask(task)
  showToast('视频任务已提交', 'success')

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }

  executeVideoTask(task.id)
}
