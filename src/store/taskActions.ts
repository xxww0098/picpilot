import type { InputImage, TaskParams, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { getCachedAuthUser } from '../lib/shared/auth'
import {
  DEFAULT_SETTINGS,
  getActiveApiProfile,
  normalizeSettings,
  validateApiProfile,
} from '../lib/shared/apiProfiles'
import {
  clearAgentConversations as dbClearAgentConversations,
  clearImages,
  clearTasks as dbClearTasks,
  clearVideos,
  deleteImage,
  deleteTask as dbDeleteTask,
  storeImage,
} from '../lib/shared/db'
import { logger, serializeError } from '../lib/shared/logger'
import { replaceImageMentionsForApi } from '../lib/ui/promptImageMentions'
import { normalizeParamsForSettings } from '../lib/params/paramCompatibility'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import { firstActualParams, readImageSizeParamsList } from '../lib/agent/taskPersistence'
import { fileToDataUrl, readBlobAsDataUrl } from '../lib/imaging/dataUrl'
import { preprocessImageFile } from '../lib/imaging/imagePreprocess'
import { scrubAgentOutputPayloadsForDeletedTasks } from '../lib/agent/agentOrchestrator'
import { cacheImage, clearImageCaches, ensureImageCached, evictCachedImage } from './imageCache'
import { useStore } from './coreStore'
import {
  callImageApiWithStreamFallback,
  createSettingsForApiProfile,
  getTaskApiProfile,
  getTaskApiProfileName,
  sourceFromProfile,
} from './taskProfiles'
import {
  addAgentReferencedImageIds,
  addInputDraftReferencedImageIds,
  addTaskReferencedImageIds,
  addTaskReferencedVideoIds,
  deleteUnreferencedImageIds,
  deleteUnreferencedVideoIds,
  getTaskAppMode,
  replaceImageKeyedValue,
  replaceRawImageUrl,
  resolveImageApiFanoutConcurrency,
  updateTaskInStore,
} from './taskRuntime'
import { submitTask } from './taskSubmit'

/** 重新生成任务中的单张输出图：保留原卡片，只替换指定 outputImages 槽位。 */
export async function regenerateTaskImage(taskId: string, imageIndex: number): Promise<void> {
  const state = useStore.getState()
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return
  const appMode = getTaskAppMode(task)

  if (task.mediaType === 'video' || task.status !== 'done') {
    state.showToast('当前记录不能重新生成单张图片', 'error')
    return
  }
  if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= task.outputImages.length) {
    state.showToast('找不到要重新生成的图片', 'error')
    return
  }

  const oldImageId = task.outputImages[imageIndex]
  const { settings } = state
  const taskProfile = getTaskApiProfile(settings, task)
  const fallbackToCurrentProfile = Boolean(!taskProfile && task.apiProfileId)

  const activeProfile = taskProfile ?? getActiveApiProfile(settings)
  const apiProfileError = validateApiProfile(activeProfile)
  if (apiProfileError) {
    state.showToast(`API 配置未完成：${apiProfileError}`, 'error')
    state.setShowSettings(true)
    return
  }

  let requestInputImageIds = task.inputImageIds
  let promptImageCount = requestInputImageIds.length
  let requestMaskImageId = task.maskImageId
  if (task.perInputImage && task.inputImageIds.length > 1) {
    const perInputCount = Math.max(1, task.params.n > 0 ? task.params.n : 1)
    const expectedOutputCount = task.inputImageIds.length * perInputCount
    if (task.outputImages.length !== expectedOutputCount) {
      state.showToast('这张合并卡无法定位对应参考图，请重试整条记录。', 'error')
      return
    }

    const inputImageId = task.inputImageIds[Math.floor(imageIndex / perInputCount)]
    if (!inputImageId) {
      state.showToast('找不到要重新生成的参考图', 'error')
      return
    }
    requestInputImageIds = [inputImageId]
    promptImageCount = 1
    requestMaskImageId = null
  }

  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = fallbackToCurrentProfile ? activeProfile.provider : task.apiProvider ?? activeProfile.provider
  let customTaskInfo: { taskId: string } | null = null
  let markedRegenerating = false
  const runningImageIndex = useStore.getState().regeneratingImageSlots[taskId]
  if (runningImageIndex != null) {
    state.showToast(`第 ${runningImageIndex + 1} 张图片正在重新生成，请稍候`, 'info')
    return
  }

  try {
    useStore.getState().setRegeneratingImageSlot(taskId, imageIndex)
    markedRegenerating = true
    state.showToast(
      fallbackToCurrentProfile
        ? `原 API 配置「${getTaskApiProfileName(task)}」已不存在，已使用当前配置「${activeProfile.name}」重新生成第 ${imageIndex + 1} 张图片`
        : `已开始重新生成第 ${imageIndex + 1} 张图片`,
      'info',
    )

    const inputDataUrls = await Promise.all(
      requestInputImageIds.map(async (imgId) => {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        return dataUrl
      }),
    )
    let maskDataUrl: string | undefined
    if (requestMaskImageId) {
      maskDataUrl = await ensureImageCached(requestMaskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    logger.info('task', '单张图片重新生成开始', {
      appMode,
      taskId,
      imageIndex,
      provider: taskProvider,
      profileName: activeProfile.name,
      model: activeProfile.model,
      inputImages: requestInputImageIds.length,
      mask: Boolean(requestMaskImageId),
    })

    const fanoutConcurrency = await resolveImageApiFanoutConcurrency()
    const promptForApi = replaceImageMentionsForApi(task.prompt, promptImageCount)
    const requestParams = { ...task.params, n: 1 }
    customTaskInfo = null
    const result = await callImageApiWithStreamFallback({
      settings: requestSettings,
      prompt: promptForApi,
      params: requestParams,
      telemetry: {
        actionType: 'regenerate_image',
        appMode,
        taskId,
        imageIndex,
        awaitReport: true,
      },
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
      onCustomTaskEnqueued: (request) => {
        customTaskInfo = request
      },
      fanoutConcurrency,
    }, {
      profile: activeProfile,
      appMode,
      taskId,
      notify: () => state.showToast(`上游流式响应断开，正在关闭流式重试第 ${imageIndex + 1} 张图片`, 'info'),
      detail: {
        action: 'regenerate_image',
        imageIndex,
      },
    })

    const replacementImage = result.images[0]
    if (!replacementImage) throw new Error('接口没有返回可替换的图片')

    const newImageId = await storeImage(replacementImage, 'generated')
    cacheImage(newImageId, replacementImage)

    const actualParamsList = result.actualParamsList?.length
      ? [result.actualParamsList[0]]
      : result.actualParams
      ? [result.actualParams]
      : await readImageSizeParamsList([replacementImage])
    const replacementActualParams = firstActualParams(actualParamsList)
    const isAsyncCustomTask = taskProvider !== 'openai' && Boolean(customTaskInfo)
    const replacementRevisedPrompt = isAsyncCustomTask ? '' : result.revisedPrompts?.[0]?.trim() ?? ''

    const latest = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latest || latest.status !== 'done' || latest.outputImages[imageIndex] !== oldImageId) {
      await deleteUnreferencedImageIds([newImageId])
      state.showToast('图片已变化，已放弃本次替换', 'info')
      return
    }

    const nextOutputImages = [...latest.outputImages]
    nextOutputImages[imageIndex] = newImageId
    const nextActualParams: Partial<TaskParams> = {
      ...(latest.actualParams ?? replacementActualParams ?? {}),
      n: nextOutputImages.length,
    }

    updateTaskInStore(taskId, {
      outputImages: nextOutputImages,
      rawImageUrls: replaceRawImageUrl(latest.rawImageUrls, latest.outputImages.length, imageIndex, result.rawImageUrls?.[0]),
      actualParams: nextActualParams,
      actualParamsByImage: replaceImageKeyedValue(latest.actualParamsByImage, oldImageId, newImageId, replacementActualParams),
      revisedPromptByImage: replaceImageKeyedValue(
        latest.revisedPromptByImage,
        oldImageId,
        newImageId,
        replacementRevisedPrompt || undefined,
      ),
      sourceByImage: replaceImageKeyedValue(latest.sourceByImage, oldImageId, newImageId, sourceFromProfile(activeProfile)),
      error: null,
    })
    await deleteUnreferencedImageIds([oldImageId])

    logger.info('task', '单张图片重新生成完成', { appMode, taskId, imageIndex, oldImageId, newImageId })
    state.showToast(`已重新生成第 ${imageIndex + 1} 张图片`, 'success')
  } catch (err) {
    const isNetworkOrTimeout = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
    const message = getUserFacingErrorMessage(err, '重新生成失败', { apiUpstream: !isNetworkOrTimeout })
    logger.error('task', '单张图片重新生成失败', {
      appMode,
      taskId,
      imageIndex,
      provider: task.apiProvider,
      model: task.apiModel,
      apiMode: task.apiMode,
      error: serializeError(err),
    })
    state.showToast(`重新生成失败：${message}`, 'error')
  } finally {
    if (markedRegenerating && useStore.getState().regeneratingImageSlots[taskId] === imageIndex) {
      useStore.getState().setRegeneratingImageSlot(taskId, null)
    }
    for (const imgId of requestInputImageIds) evictCachedImage(imgId)
  }
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const matchedProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(normalizedSettings, matchedProfile) : normalizedSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, {
    hasInputImages: task.inputImageIds.length > 0,
    maxOutputImages: getCachedAuthUser()?.maxBatchImages,
  }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord, selectedOutputImageIds?: string[]) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  const taskOutputImageIds = new Set(task.outputImages)
  const outputImageIds = (selectedOutputImageIds?.length ? selectedOutputImageIds : task.outputImages)
    .filter((imgId, index, arr) => taskOutputImageIds.has(imgId) && arr.indexOf(imgId) === index)
  if (!outputImageIds.length) return

  let added = 0
  for (const imgId of outputImageIds) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 将任务输出作为画廊参考图继续编辑。 */
export async function sendTaskOutputsToGallery(task: TaskRecord) {
  const { setAppMode, setInputImages, setPrompt, setParams, clearMaskDraft, showToast } = useStore.getState()
  if (!task.outputImages?.length) {
    showToast('该任务没有可发送到画廊的图片', 'info')
    return
  }

  const imgs: InputImage[] = []
  for (const imgId of task.outputImages) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) imgs.push({ id: imgId, dataUrl })
  }
  if (imgs.length === 0) {
    showToast('输出图片已不存在', 'error')
    return
  }

  setAppMode('gallery')
  clearMaskDraft()
  setInputImages(imgs)
  setPrompt(task.prompt)
  setParams(normalizeParamsForSettings(task.params, normalizeSettings(useStore.getState().settings), {
    hasInputImages: imgs.length > 0,
    maxOutputImages: getCachedAuthUser()?.maxBatchImages,
  }))
  showToast(`已发送 ${imgs.length} 张图到画廊输入区`, 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, galleryInputDraft, showToast, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const deletedTasks = tasks.filter(t => toDelete.has(t.id))
  const remaining = await scrubAgentOutputPayloadsForDeletedTasks(deletedTasks, tasks.filter(t => !toDelete.has(t.id)))

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  const deletedVideoIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      addTaskReferencedImageIds(deletedImageIds, t)
      addTaskReferencedVideoIds(deletedVideoIds, t)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    addTaskReferencedImageIds(stillUsed, t)
  }
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      evictCachedImage(imgId)
    }
  }

  await deleteUnreferencedVideoIds(deletedVideoIds)

  // 如果删除的任务在选中列表中，则移除
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, galleryInputDraft, showToast } = useStore.getState()

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
    ...(task.streamPartialImageIds || []),
  ])
  const taskVideoIds = new Set(task.outputVideos || [])

  // 从列表移除
  const remaining = await scrubAgentOutputPayloadsForDeletedTasks([task], tasks.filter((t) => t.id !== task.id))
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    addTaskReferencedImageIds(stillUsed, t)
  }
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      evictCachedImage(imgId)
    }
  }

  await deleteUnreferencedVideoIds(taskVideoIds)

  showToast('记录已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()

  if (options.clearTasks) {
    await dbClearTasks()
    await dbClearAgentConversations()
    await clearImages()
    await clearVideos()
    clearImageCaches()
    setTasks([])
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
    })
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    useStore.setState({ dismissedCodexCliPrompts: [] })
    setSettings({ ...DEFAULT_SETTINGS })
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  const image = await createInputImageFromFile(file)
  if (!image) return
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  if (!file.type.startsWith('image/')) return null
  const { dataUrl } = await preprocessImageFile(file).catch(async () => ({ dataUrl: await fileToDataUrl(file), resized: false }))
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await readBlobAsDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}
