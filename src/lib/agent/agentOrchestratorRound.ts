// Agent 编排执行层：executeAgentRound 单轮执行（Responses 循环、工具调用、流式任务）（从 agentOrchestrator.ts 拆出）。
import type {
  AgentMessage,
  ApiProfile,
  AppSettings,
  ResponsesOutputItem,
  TaskParams,
  TaskRecord,
} from '../../types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS } from '../../types'
import { chatModelSupportsHostedImageTool, getAgentImageEngine } from '../image/chatModels'
import { callAgentResponsesApi, callBatchImageSingle, parseBatchImageCallArguments, type AgentApiResultImage } from './agentApi'
import { collectAgentRoundOutputImageSlots, extractAgentReferenceIds, getAgentCurrentReferenceId, getAgentGeneratedImageReferenceId } from './agentImageReferences'
import { IMAGE_FETCH_CORS_HINT } from '../image/imageApiShared'
import { getApiRequestNetworkErrorHint, getUpstreamApiErrorHint } from '../task/taskErrorHints'
import { getUserFacingErrorMessage } from '../shared/userFacingText'
import { shouldRunAgentNoImageFallback } from './agentNoImageFallback'
import { storeImage } from '../shared/db'
import { cacheImage, ensureImageCached } from '../../store/imageCache'
import { getCachedAuthUser } from '../shared/auth'
import { logger, serializeError } from '../shared/logger'
import { getAgentRoundPath } from './agentConversationTree'
import { addTaskToAgentAssetPlan, finalizeAgentAssetPlanSlotStatus, withAgentPlatformTaskMetadata } from './agentPlatformContext'
import {
  AGENT_STOPPED_MESSAGE,
  agentRoundControllers,
  appendAgentAssistantMessageContent,
  createAgentAbortError,
  genId,
  getAgentRoundControllerKey,
  getState,
  markAgentRoundStopped,
  persistTaskStreamPartialImage,
  putTask,
  resolveAgentTaskPrompt,
  uniqueIds,
  updateAgentConversation,
  updateTaskInStore,
} from './agentOrchestratorShared'
import {
  buildAgentApiInput,
  buildAgentContinuationInput,
  countResponseToolCalls,
  createAgentBatchImagesInputItem,
  mergeResponseOutputItems,
} from './agentOrchestratorInput'

export async function executeAgentRound(
  conversationId: string,
  roundId: string,
  params: TaskParams,
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
) {
  // Agent 对话用独立的 agentModel（与图像配置解耦）；超时/流式等沿用活动配置。
  const agentProfile: ApiProfile = { ...activeProfile, apiMode: 'responses', model: requestSettings.agentModel }
  // 该对话模型实际出图所用的图像模型：支持托管工具(gpt-5.5)沿用活动配置；否则(grok)用其 imageEngine。
  const agentImageModel = chatModelSupportsHostedImageTool(requestSettings.agentModel)
    ? activeProfile.model
    : getAgentImageEngine(requestSettings.agentModel)
  const agentImageProvider = chatModelSupportsHostedImageTool(requestSettings.agentModel)
    ? activeProfile.provider
    : 'xAI'
  const startedAt = Date.now()
  const controller = new AbortController()
  const controllerKey = getAgentRoundControllerKey(conversationId, roundId)
  const streamingTaskIds: string[] = []
  const markAgentTaskError = (taskId: string | undefined, error: string, patch: Partial<TaskRecord> = {}) => {
    if (!taskId) return
    const latestTask = getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || (latestTask.status === 'done' && latestTask.outputImages.length > 0)) return
    updateTaskInStore(taskId, {
      status: 'error',
      error,
      finishedAt: Date.now(),
      elapsed: Date.now() - latestTask.createdAt,
      ...patch,
    })
    getState().setTaskStreamPreview(taskId)
  }
  const markIncompleteAgentTasksError = (message: string, patch: Partial<TaskRecord> = {}) => {
    for (const taskId of streamingTaskIds) {
      markAgentTaskError(taskId, message, patch)
    }
  }
  agentRoundControllers.set(controllerKey, controller)
  try {
    const latestState = getState()
    const conversation = latestState.agentConversations.find((item) => item.id === conversationId)
    if (!conversation) return
    const round = conversation.rounds.find((item) => item.id === roundId)
    const userMessage = round ? conversation.messages.find((message) => message.id === round.userMessageId) : null
    if (!round || !userMessage) return
    logger.info('agent', 'Agent 轮次开始执行', {
      appMode: 'agent',
      conversationId,
      roundId,
      agentModel: requestSettings.agentModel,
      imageProvider: agentImageProvider,
      imageModel: agentImageModel,
      inputImages: round.inputImageIds.length,
      mask: Boolean(round.maskImageId),
      promptChars: userMessage.content.length,
    })
    const maskDataUrl = round.maskImageId ? await ensureImageCached(round.maskImageId) : undefined
    if (round.maskImageId && !maskDataUrl) throw new Error('遮罩图片已不存在')

    const apiInput = await buildAgentApiInput(conversation, round, latestState.tasks)
    if (controller.signal.aborted) throw createAgentAbortError()
    const existingAssistantMessage = round.assistantMessageId
      ? conversation.messages.find((message) => message.id === round.assistantMessageId) ?? null
      : conversation.messages.find((message) => message.roundId === roundId && message.role === 'assistant') ?? null
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    const shouldStreamAssistantMessage = activeProfile.streamImages === true
    const taskIdByToolCallId = new Map<string, string>()

    const attachTaskToAgentRound = (taskId: string) => {
      if (streamingTaskIds.includes(taskId)) return
      streamingTaskIds.push(taskId)
      updateAgentConversation(conversationId, (current) => {
        const currentRound = current.rounds.find((item) => item.id === roundId)
        const assetPlan = currentRound
          ? addTaskToAgentAssetPlan(current.assetPlan, currentRound.targetAssetSlotId, taskId)
          : current.assetPlan
        return {
          ...current,
          ...(assetPlan ? { assetPlan } : {}),
          updatedAt: Date.now(),
          rounds: current.rounds.map((item) =>
            item.id === roundId
              ? { ...item, outputTaskIds: item.outputTaskIds.includes(taskId) ? item.outputTaskIds : [...item.outputTaskIds, taskId] }
              : item,
          ),
          messages: current.messages.map((message) =>
            message.id === assistantMessageId
              ? { ...message, outputTaskIds: [...new Set([...(message.outputTaskIds ?? []), taskId])] }
              : message,
          ),
        }
      })
    }

    const ensureStreamingAgentTask = async (
      toolCallId: string,
      taskPrompt = '',
      inputImageIds = round.inputImageIds ?? [],
      options: { createdAt?: number; agentBatchCallId?: string; maskTargetImageId?: string | null; maskImageId?: string | null } = {},
    ): Promise<string | null> => {
      const latestConversation = getState().agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId) ?? null
      if (!latestConversation || !latestRound) return null

      const existingTaskId = taskIdByToolCallId.get(toolCallId)
      if (existingTaskId) return existingTaskId

      const existingTask = getState().tasks.find((task) => task.agentToolCallId === toolCallId)
      if (existingTask) {
        taskIdByToolCallId.set(toolCallId, existingTask.id)
        attachTaskToAgentRound(existingTask.id)
        const resolvedExistingPrompt = resolveAgentTaskPrompt(existingTask.prompt, latestRound.prompt, userMessage.content)
        if (resolvedExistingPrompt && resolvedExistingPrompt !== existingTask.prompt) {
          updateTaskInStore(existingTask.id, { prompt: resolvedExistingPrompt })
        }
        return existingTask.id
      }

      const resolvedTaskPrompt = resolveAgentTaskPrompt(taskPrompt, latestRound.prompt, userMessage.content)
      const task: TaskRecord = {
        id: genId(),
        prompt: resolvedTaskPrompt,
        params: { ...params, n: 1 },
        apiProvider: agentImageProvider,
        apiProfileId: activeProfile.id,
        apiProfileName: activeProfile.name,
        apiMode: activeProfile.apiMode,
        apiModel: agentImageModel,
        inputImageIds,
        maskTargetImageId: options.maskTargetImageId !== undefined ? options.maskTargetImageId : round.maskTargetImageId ?? null,
        maskImageId: options.maskImageId !== undefined ? options.maskImageId : round.maskImageId ?? null,
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: options.createdAt ?? Date.now(),
        finishedAt: null,
        elapsed: null,
        sourceMode: 'agent',
        agentConversationId: conversationId,
        agentRoundId: roundId,
        agentMessageId: assistantMessageId,
        agentToolCallId: toolCallId,
        ...(options.agentBatchCallId ? { agentBatchCallId: options.agentBatchCallId } : {}),
      }

      const taskWithPlatform = withAgentPlatformTaskMetadata(task, latestConversation, latestRound)
      taskIdByToolCallId.set(toolCallId, taskWithPlatform.id)
      getState().setTasks([taskWithPlatform, ...getState().tasks])
      attachTaskToAgentRound(taskWithPlatform.id)
      await putTask(taskWithPlatform)
      return taskWithPlatform.id
    }

    const completeAgentImageTask = async (image: AgentApiResultImage, rawResponsePayload?: string) => {
      const toolCallId = image.toolCallId ?? genId()
      const taskId = await ensureStreamingAgentTask(toolCallId)
      if (!taskId) return null
      const latestTask = getState().tasks.find((task) => task.id === taskId)
      if (latestTask?.status === 'done' && latestTask.outputImages.length > 0) return taskId

      const imgId = await storeImage(image.dataUrl, 'generated')
      cacheImage(imgId, image.dataUrl)
      const actualParams: Partial<TaskParams> = {
        ...(Object.keys(image.actualParams ?? {}).length ? image.actualParams : {}),
        n: 1,
      }
      updateTaskInStore(taskId, {
        prompt: image.revisedPrompt ?? latestTask?.prompt ?? '',
        outputImages: [imgId],
        actualParams,
        actualParamsByImage: { [imgId]: actualParams },
        revisedPromptByImage: image.revisedPrompt ? { [imgId]: image.revisedPrompt } : undefined,
        rawResponsePayload,
        status: 'done',
        error: null,
        finishedAt: Date.now(),
        elapsed: Date.now() - (latestTask?.createdAt ?? startedAt),
        agentToolAction: image.action,
      })
      getState().setTaskStreamPreview(taskId)
      return taskId
    }

    if (shouldStreamAssistantMessage) {
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId ? { ...item, assistantMessageId } : item,
        ),
        messages: current.messages.some((message) => message.id === assistantMessageId)
          ? current.messages.map((message) => message.id === assistantMessageId ? { ...message, content: '', outputTaskIds: [] } : message)
          : [
              ...current.messages,
              {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                roundId,
                createdAt: Date.now(),
              },
            ],
      }))
    }
    const maxToolCalls = Number.isFinite(requestSettings.agentMaxToolRounds)
      ? Math.max(1, Math.trunc(requestSettings.agentMaxToolRounds))
      : DEFAULT_AGENT_MAX_TOOL_ROUNDS
    let apiInputForTurn = apiInput
    let accumulatedOutputItems: ResponsesOutputItem[] = []
    let accumulatedText = ''
    const textSegments: string[] = []
    let lastResponseId: string | undefined
    let toolCallsUsed = 0
    let reachedToolLimit = false
    let pendingToolTextSeparator = false
    let usedNoImageFallback = false

    // Helper: resolve reference image ids to data URLs for batch image calls
    const resolveReferenceImages = async (referenceIds: string[]): Promise<{ dataUrls: string[]; imageIds: string[] }> => {
      const dataUrls: string[] = []
      const imageIds: string[] = []
      for (const refId of referenceIds) {
        // Resolve both generated image refs and current/user input refs from XML tags.
        const latestConv = getState().agentConversations.find((item) => item.id === conversationId)
        if (!latestConv) continue
        for (const r of getAgentRoundPath(latestConv, roundId)) {
          for (let imgIdx = 0; imgIdx < r.inputImageIds.length; imgIdx++) {
            const currentRefId = getAgentCurrentReferenceId(r, imgIdx)
            if (currentRefId === refId) {
              const imageId = r.inputImageIds[imgIdx]
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
          const outputImages = collectAgentRoundOutputImageSlots(r, getState().tasks)
          for (let imgIdx = 0; imgIdx < outputImages.length; imgIdx++) {
            const generatedRefId = getAgentGeneratedImageReferenceId(r, imgIdx)
            if (generatedRefId === refId) {
              const imageId = outputImages[imgIdx]
              if (!imageId) continue
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
        }
      }
      return { dataUrls, imageIds }
    }

    const resolveNoImageFallbackReferences = async (): Promise<{ dataUrls: string[]; imageIds: string[]; referenceIds: string[] }> => {
      const latestConversation = getState().agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId) ?? null
      if (!latestConversation || !latestRound) return { dataUrls: [], imageIds: [], referenceIds: [] }

      const referenceIds: string[] = []
      if (latestRound.inputImageIds.length > 0) {
        for (let index = 0; index < latestRound.inputImageIds.length; index++) {
          referenceIds.push(getAgentCurrentReferenceId(latestRound, index))
        }
      }

      if (referenceIds.length === 0) {
        const path = getAgentRoundPath(latestConversation, roundId)
        for (let roundIndex = path.length - 2; roundIndex >= 0; roundIndex--) {
          const previousRound = path[roundIndex]
          const outputImages = collectAgentRoundOutputImageSlots(previousRound, getState().tasks)
          if (outputImages.length === 0) continue
          for (let imageIndex = 0; imageIndex < outputImages.length; imageIndex++) {
            if (outputImages[imageIndex]) referenceIds.push(getAgentGeneratedImageReferenceId(previousRound, imageIndex))
          }
          break
        }
      }

      const references = await resolveReferenceImages(uniqueIds(referenceIds))
      return { ...references, referenceIds: uniqueIds(referenceIds) }
    }

    const executeNoImageFallback = async () => {
      const references = await resolveNoImageFallbackReferences()
      const fallbackToolCallId = genId()
      const referenceHint = references.referenceIds.length > 0
        ? `Use the attached reference image(s) as the visual source: ${references.referenceIds.map((id) => `<ref id="${id}" />`).join(', ')}.`
        : ''
      const fallbackPrompt = [
        'The previous Agent response ended without an image-generation tool call even though the user explicitly requested an image. Generate exactly one image now. Do not answer with text only.',
        referenceHint,
        userMessage.content,
      ].filter(Boolean).join('\n\n')
      const taskId = await ensureStreamingAgentTask(fallbackToolCallId, userMessage.content, references.imageIds, {
        createdAt: Date.now(),
        maskTargetImageId: round.maskTargetImageId ?? null,
        maskImageId: round.maskImageId ?? null,
      })

      logger.warn('agent', 'Agent 未调用出图工具，启动单图兜底', {
        appMode: 'agent',
        conversationId,
        roundId,
        taskId,
        referenceImages: references.imageIds.length,
      })

      const fallbackResult = await callBatchImageSingle({
        settings: requestSettings,
        profile: agentProfile,
        params,
        batchItemId: 'agent_no_image_fallback',
        prompt: fallbackPrompt,
        referenceImageDataUrls: references.dataUrls,
        referenceIds: references.referenceIds,
        signal: controller.signal,
        onImageToolStarted: shouldStreamAssistantMessage
          ? async () => {
              if (controller.signal.aborted) return
            }
          : undefined,
        onPartialImage: shouldStreamAssistantMessage
          ? async ({ image, partialImageIndex }) => {
              if (controller.signal.aborted || !taskId) return
              getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) {
                void persistTaskStreamPartialImage(taskId, image)
              }
            }
          : undefined,
        onImageToolCompleted: shouldStreamAssistantMessage
          ? async (image) => {
              if (controller.signal.aborted) return
              await completeAgentImageTask({ ...image, toolCallId: fallbackToolCallId })
            }
          : undefined,
      })

      if (fallbackResult.image && !shouldStreamAssistantMessage) {
        await completeAgentImageTask({ ...fallbackResult.image, toolCallId: fallbackToolCallId }, fallbackResult.rawResponsePayload)
      }
      if (fallbackResult.rawResponsePayload && taskId) {
        const latestTask = getState().tasks.find((task) => task.id === taskId)
        if (latestTask && !latestTask.rawResponsePayload) updateTaskInStore(taskId, { rawResponsePayload: fallbackResult.rawResponsePayload })
      }
      if (!fallbackResult.image) {
        const error = fallbackResult.error || 'Agent 兜底出图未返回图片'
        markAgentTaskError(taskId ?? undefined, error)
        throw new Error(error)
      }
      toolCallsUsed += 1
    }

    // Helper: execute a generate_image_batch function call concurrently
    const executeBatchFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string> => {
      const callId = functionCallItem.call_id ?? ''
      const args = functionCallItem.arguments ?? ''
      const batchItems = parseBatchImageCallArguments(args)

      if (!batchItems || batchItems.length === 0) {
        return JSON.stringify({ error: 'Invalid or empty batch arguments' })
      }
      const maxBatchImages = getCachedAuthUser()?.maxBatchImages
      if (maxBatchImages && batchItems.length > maxBatchImages) {
        return JSON.stringify({
          error: `单次批量生成数量上限为 ${maxBatchImages} 张，本次请求 ${batchItems.length} 张。请减少批量数量。`,
          max_batch_images: maxBatchImages,
          requested: batchItems.length,
        })
      }

      // Create task cards in model-provided order before starting network calls.
      const batchExecutionItems = []
      for (const item of batchItems) {
        const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
        const references = await resolveReferenceImages(referenceIds)
        const batchToolCallId = genId()
        await ensureStreamingAgentTask(batchToolCallId, item.prompt, references.imageIds, {
          createdAt: Date.now(),
          maskTargetImageId: null,
          maskImageId: null,
          ...(callId ? { agentBatchCallId: callId } : {}),
        })
        batchExecutionItems.push({ item, batchToolCallId, references, referenceIds })
      }

      // Fire all batch items concurrently after all cards are visible.
      const batchPromises = batchExecutionItems.map(async ({ item, batchToolCallId, references, referenceIds }) => {
        try {
          const batchResult = await callBatchImageSingle({
            settings: requestSettings,
            profile: agentProfile,
            params,
            batchItemId: item.id,
            prompt: item.prompt,
            referenceImageDataUrls: references.dataUrls,
            referenceIds,
            signal: controller.signal,
            onImageToolStarted: shouldStreamAssistantMessage
              ? async () => {
                  if (controller.signal.aborted) return
                }
              : undefined,
            onPartialImage: shouldStreamAssistantMessage
              ? async ({ image, partialImageIndex }) => {
                  if (controller.signal.aborted) return
                  const taskId = taskIdByToolCallId.get(batchToolCallId)
                  if (taskId) {
                    getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                    if (partialImageIndex === 0 || partialImageIndex == null) {
                      void persistTaskStreamPartialImage(taskId, image)
                    }
                  }
                }
              : undefined,
            onImageToolCompleted: shouldStreamAssistantMessage
              ? async (image) => {
                  if (controller.signal.aborted) return
                  await completeAgentImageTask({ ...image, toolCallId: batchToolCallId })
                }
            : undefined,
        })

          // If not streaming and we have an image, complete the pre-created task.
          if (batchResult.image && !shouldStreamAssistantMessage) {
            await completeAgentImageTask({ ...batchResult.image, toolCallId: batchToolCallId }, batchResult.rawResponsePayload)
          }
          if (!batchResult.image) {
            markAgentTaskError(taskIdByToolCallId.get(batchToolCallId), batchResult.error || '未返回图片')
          }

          return batchResult
        } catch (err) {
          markAgentTaskError(
            taskIdByToolCallId.get(batchToolCallId),
            err instanceof Error ? err.message : String(err),
          )
          throw err
        }
      })

      const batchResults = await Promise.allSettled(batchPromises)

      // Build function_call_output
      const outputImages: Array<{ id: string; status: string; error?: string }> = []
      for (let i = 0; i < batchItems.length; i++) {
        const settled = batchResults[i]
        const batchItem = batchItems[i]
        if (settled.status === 'fulfilled') {
          const r = settled.value
          outputImages.push({
            id: r.batchItemId,
            status: r.image ? 'done' : 'error',
            ...(r.error ? { error: r.error } : {}),
          })
        } else {
          outputImages.push({
            id: batchItem.id,
            status: 'error',
            error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
          })
        }
      }

      const successCount = outputImages.filter((img) => img.status === 'done').length
      toolCallsUsed += successCount

      return JSON.stringify({ images: outputImages })
    }

    while (true) {
      if (controller.signal.aborted) throw createAgentAbortError()
      const textBeforeResponse = accumulatedText
      let currentResponseOutputItems: ResponsesOutputItem[] = []
      const result = await callAgentResponsesApi({
        settings: requestSettings,
        profile: agentProfile,
        params,
        input: apiInputForTurn,
        platformContext: {
          platformId: conversation.platformId,
          brief: conversation.platformBrief,
          assetPlan: conversation.assetPlan,
          targetAssetSlotId: round.targetAssetSlotId,
        },
        telemetry: {
          prompt: userMessage.content,
          roundId,
          inputImageCount: round.inputImageIds.length,
          hasMask: Boolean(round.maskImageId),
        },
        maskDataUrl,
        signal: controller.signal,
        onTextDelta: shouldStreamAssistantMessage
          ? (delta) => {
              if (controller.signal.aborted) return
              if (pendingToolTextSeparator && delta && accumulatedText.trim()) {
                accumulatedText += '\n\n'
                appendAgentAssistantMessageContent(conversationId, assistantMessageId, '\n\n')
              }
              pendingToolTextSeparator = false
              accumulatedText += delta
              appendAgentAssistantMessageContent(conversationId, assistantMessageId, delta)
            }
          : undefined,
        onOutputItems: shouldStreamAssistantMessage
          ? (outputItems) => {
              if (controller.signal.aborted) return
              currentResponseOutputItems = outputItems
              updateAgentConversation(conversationId, (current) => ({
                ...current,
                rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseOutput: mergeResponseOutputItems(accumulatedOutputItems, outputItems) } : item),
              }))
            }
          : undefined,
        onImageToolStarted: shouldStreamAssistantMessage
          ? async ({ toolCallId }) => {
              if (controller.signal.aborted) return
              await ensureStreamingAgentTask(toolCallId)
            }
          : undefined,
        onImagePartialImage: shouldStreamAssistantMessage
          ? async ({ toolCallId, image, partialImageIndex }) => {
              if (controller.signal.aborted) return
              const taskId = await ensureStreamingAgentTask(toolCallId)
              if (!taskId) return
              if (controller.signal.aborted) return
              getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) {
                void persistTaskStreamPartialImage(taskId, image)
              }
            }
          : undefined,
        onImageToolCompleted: shouldStreamAssistantMessage
          ? async (image) => {
              if (controller.signal.aborted) return
              await completeAgentImageTask(image)
            }
          : undefined,
      })
      if (controller.signal.aborted) throw createAgentAbortError()

      lastResponseId = result.responseId ?? lastResponseId
      currentResponseOutputItems = currentResponseOutputItems.length ? currentResponseOutputItems : result.outputItems ?? []
      accumulatedOutputItems = mergeResponseOutputItems(accumulatedOutputItems, currentResponseOutputItems)

      const responseText = result.text.trim()
      if (responseText && accumulatedText === textBeforeResponse) {
        const textToAppend = accumulatedText ? `\n\n${responseText}` : responseText
        accumulatedText += textToAppend
        if (shouldStreamAssistantMessage) appendAgentAssistantMessageContent(conversationId, assistantMessageId, textToAppend)
      }
      const newTextInThisResponse = accumulatedText.slice(textBeforeResponse.length).trim()
      if (newTextInThisResponse) textSegments.push(newTextInThisResponse)

      // Process built-in image_generation_call results (single images)
      for (const image of result.images) {
        if (image.toolCallId && taskIdByToolCallId.has(image.toolCallId)) {
          const completedTaskId = await completeAgentImageTask(image, result.rawResponsePayload)
          if (!completedTaskId) continue
          const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
          if (promptRefIds.length > 0) {
            const promptRefs = await resolveReferenceImages(promptRefIds)
            if (promptRefs.imageIds.length > 0) {
              const latestTask = getState().tasks.find((t) => t.id === completedTaskId)
              if (latestTask) {
                const mergedInputIds = uniqueIds([...latestTask.inputImageIds, ...promptRefs.imageIds])
                if (mergedInputIds.length !== latestTask.inputImageIds.length) {
                  updateTaskInStore(completedTaskId, { inputImageIds: mergedInputIds })
                }
              }
            }
          }
          continue
        }
        const latestConversationForImage = getState().agentConversations.find((item) => item.id === conversationId)
        const latestRoundForImage = latestConversationForImage?.rounds.find((item) => item.id === roundId) ?? null
        if (!latestConversationForImage || !latestRoundForImage) continue
        const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
        const promptRefs = await resolveReferenceImages(promptRefIds)
        const imgId = await storeImage(image.dataUrl, 'generated')
        cacheImage(imgId, image.dataUrl)
        const finalConversationForImage = getState().agentConversations.find((item) => item.id === conversationId)
        const finalRoundForImage = finalConversationForImage?.rounds.find((item) => item.id === roundId) ?? null
        if (!finalConversationForImage || !finalRoundForImage) continue
        const actualParams: Partial<TaskParams> = {
          ...(Object.keys(image.actualParams ?? {}).length ? image.actualParams : {}),
          n: 1,
        }
        const task: TaskRecord = {
          id: genId(),
          prompt: image.revisedPrompt ?? finalRoundForImage.prompt ?? userMessage.content,
          params,
          apiProvider: agentImageProvider,
          apiProfileId: activeProfile.id,
          apiProfileName: activeProfile.name,
          apiMode: activeProfile.apiMode,
          apiModel: activeProfile.model,
          inputImageIds: uniqueIds([...finalRoundForImage.inputImageIds, ...promptRefs.imageIds]),
          maskTargetImageId: finalRoundForImage.maskTargetImageId ?? null,
          maskImageId: finalRoundForImage.maskImageId ?? null,
          outputImages: [imgId],
          actualParams,
          actualParamsByImage: { [imgId]: actualParams },
          revisedPromptByImage: image.revisedPrompt ? { [imgId]: image.revisedPrompt } : undefined,
          rawResponsePayload: result.rawResponsePayload,
          status: 'done',
          error: null,
          createdAt: startedAt,
          finishedAt: Date.now(),
          elapsed: Date.now() - startedAt,
          sourceMode: 'agent',
          agentConversationId: conversationId,
          agentRoundId: roundId,
          agentMessageId: assistantMessageId,
          agentToolCallId: image.toolCallId,
          agentToolAction: image.action,
        }
        const taskWithPlatform = withAgentPlatformTaskMetadata(task, finalConversationForImage, finalRoundForImage)
        getState().setTasks([taskWithPlatform, ...getState().tasks])
        attachTaskToAgentRound(taskWithPlatform.id)
        await putTask(taskWithPlatform)
      }

      if (result.rawResponsePayload && streamingTaskIds.length > 0) {
        for (const taskId of streamingTaskIds) {
          const latestTask = getState().tasks.find((task) => task.id === taskId)
          if (latestTask && !latestTask.rawResponsePayload) updateTaskInStore(taskId, { rawResponsePayload: result.rawResponsePayload })
        }
      }

      // Check for function calls that require continuation
      const batchFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image_batch',
      )
      const continueFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'continue_generation',
      )

      // Count built-in tool calls (image_generation, web_search) for budget tracking
      const responseToolCalls = countResponseToolCalls(currentResponseOutputItems)
      toolCallsUsed += responseToolCalls

      // Collect function_call_output items for all function calls that need responses
      const functionCallOutputs: ResponsesOutputItem[] = []

      if (batchFunctionCalls.length > 0) {
        for (const fc of batchFunctionCalls) {
          const output = await executeBatchFunctionCall(fc)
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      for (const fc of continueFunctionCalls) {
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify({ status: 'continued' }),
        })
      }

      // If no function calls need output → model decided the task is done → break
      if (functionCallOutputs.length === 0) {
        const latestRoundForFallback = getState().agentConversations
          .find((item) => item.id === conversationId)
          ?.rounds.find((item) => item.id === roundId)
        const latestTaskIds = latestRoundForFallback?.outputTaskIds ?? streamingTaskIds
        const latestTasksForFallback = getState().tasks
        const latestOutputImageCount = latestTaskIds.reduce(
          (count, taskId) => count + (latestTasksForFallback.find((task) => task.id === taskId)?.outputImages.length ?? 0),
          0,
        )
        if (!usedNoImageFallback && shouldRunAgentNoImageFallback({
          prompt: userMessage.content,
          outputTaskCount: latestTaskIds.length,
          outputImageCount: latestOutputImageCount,
          responseOutput: accumulatedOutputItems,
        })) {
          usedNoImageFallback = true
          await executeNoImageFallback()
        }

        updateAgentConversation(conversationId, (current) => ({
          ...current,
          updatedAt: Date.now(),
          rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItems } : item),
        }))
        break
      }

      const accumulatedOutputItemsWithFunctionOutputs = mergeResponseOutputItems(accumulatedOutputItems, functionCallOutputs)

      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItemsWithFunctionOutputs } : item),
      }))

      if (toolCallsUsed >= maxToolCalls) {
        reachedToolLimit = true
        break
      }

      // Build continuation input with function call outputs and available refs
      const latestConversation = getState().agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
      if (!latestRound) break

      const continuationBase = buildAgentContinuationInput(
        apiInput,
        latestRound,
        getState().tasks,
        accumulatedOutputItems,
        toolCallsUsed,
        maxToolCalls,
      )
      // Insert function_call_output items before the continuation system message
      continuationBase.splice(continuationBase.length - 1, 0, ...functionCallOutputs)
      // Inject batch-generated images as input_image user message for model visibility
      const batchImagesItem = await createAgentBatchImagesInputItem(latestRound, getState().tasks, streamingTaskIds)
      if (batchImagesItem) continuationBase.splice(continuationBase.length - 1, 0, batchImagesItem)
      apiInputForTurn = continuationBase
      accumulatedOutputItems = accumulatedOutputItemsWithFunctionOutputs
      pendingToolTextSeparator = true
    }

    markIncompleteAgentTasksError('未返回图片')
    const taskIds: string[] = [...streamingTaskIds]
    const latestTasks = getState().tasks
    const outputIds = taskIds.flatMap((taskId) => latestTasks.find((task) => task.id === taskId)?.outputImages ?? [])
    const limitNotice = reachedToolLimit ? `已达到最大工具调用次数（${maxToolCalls}），已停止自动续跑。` : ''
    const joinedText = textSegments.join('\n\n').trim()
    const finalContent = [joinedText, limitNotice]
      .filter(Boolean)
      .join(joinedText ? '\n\n' : '')
      || (taskIds.length > 0 || outputIds.length > 0 ? '图像已生成。' : '')

    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: finalContent,
      roundId,
      outputTaskIds: taskIds,
      createdAt: Date.now(),
    }

    updateAgentConversation(conversationId, (current) => {
      const currentRound = current.rounds.find((item) => item.id === roundId)
      if (!currentRound) return current
      const assetPlan = currentRound
        ? finalizeAgentAssetPlanSlotStatus(current.assetPlan, currentRound.targetAssetSlotId, latestTasks)
        : current.assetPlan
      return {
        ...current,
        ...(assetPlan ? { assetPlan } : {}),
        updatedAt: Date.now(),
        rounds: current.rounds.map((round) =>
          round.id === roundId
            ? {
                ...round,
                assistantMessageId,
                outputTaskIds: taskIds,
                responseId: lastResponseId,
                responseOutput: accumulatedOutputItems,
                status: 'done',
                error: null,
                finishedAt: Date.now(),
              }
            : round,
        ),
        messages: current.messages.some((message) => message.id === assistantMessageId)
          ? current.messages.map((message) => message.id === assistantMessageId ? assistantMessage : message)
          : [...current.messages, assistantMessage],
      }
    })

    logger.info('agent', 'Agent 轮次完成', {
      appMode: 'agent',
      conversationId,
      roundId,
      outputTasks: taskIds.length,
      outputImages: outputIds.length,
      textChars: finalContent.length,
      toolCallsUsed,
      elapsedMs: Date.now() - startedAt,
    })
    getState().showToast(outputIds.length > 0 ? 'Agent 已生成图片' : 'Agent 已回复', 'success')
  } catch (err) {
    if (controller.signal.aborted) {
      markIncompleteAgentTasksError(AGENT_STOPPED_MESSAGE, { customRecoverable: false })
      if (markAgentRoundStopped(conversationId, roundId)) {
        getState().showToast('已停止生成', 'info')
      }
      return
    }

    let message = err instanceof Error ? err.message : String(err)
    const usesApiProxy = true
    const networkErrorHint = getApiRequestNetworkErrorHint(err, startedAt, usesApiProxy, activeProfile)
    if (networkErrorHint && !message.includes(IMAGE_FETCH_CORS_HINT)) {
      message += `\n${networkErrorHint}`
    } else {
      const upstreamHint = getUpstreamApiErrorHint(err)
      if (upstreamHint) message += `\n${upstreamHint}`
    }
    const isNetworkOrTimeout = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
    message = getUserFacingErrorMessage(message, 'Agent 请求失败', { apiUpstream: !isNetworkOrTimeout })
    logger.error('agent', 'Agent 轮次失败', {
      appMode: 'agent',
      conversationId,
      roundId,
      elapsedMs: Date.now() - startedAt,
      error: serializeError(err),
    })

    markIncompleteAgentTasksError(message)
    updateAgentConversation(conversationId, (current) => {
      const failedRound = current.rounds.find((round) => round.id === roundId)
      if (!failedRound) return current
      const existingAssistantMessage = failedRound?.assistantMessageId
        ? current.messages.find((item) => item.id === failedRound.assistantMessageId)
        : current.messages.find((item) => item.roundId === roundId && item.role === 'assistant')
      const errorContent = `请求失败：${message}`
      const assetPlan = failedRound
        ? finalizeAgentAssetPlanSlotStatus(current.assetPlan, failedRound.targetAssetSlotId, getState().tasks)
        : current.assetPlan

      return {
        ...current,
        ...(assetPlan ? { assetPlan } : {}),
        title: current.rounds.length === 1 && current.rounds[0].id === roundId ? '新对话' : current.title,
        updatedAt: Date.now(),
        rounds: current.rounds.map((round) =>
          round.id === roundId
            ? {
                ...round,
                ...(existingAssistantMessage ? { assistantMessageId: existingAssistantMessage.id } : {}),
                status: 'error',
                error: message,
                finishedAt: Date.now(),
              }
            : round,
        ),
        messages: existingAssistantMessage
          ? current.messages.map((item) => item.id === existingAssistantMessage.id ? { ...item, content: errorContent } : item)
          : [
              ...current.messages,
              {
                id: genId(),
                role: 'assistant',
                content: errorContent,
                roundId,
                createdAt: Date.now(),
              },
            ],
      }
    })
    getState().showToast(`Agent 请求失败：${message}`, 'error')
  } finally {
    if (agentRoundControllers.get(controllerKey) === controller) {
      agentRoundControllers.delete(controllerKey)
    }
  }
}
