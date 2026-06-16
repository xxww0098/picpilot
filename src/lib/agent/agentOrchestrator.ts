// Agent 编排门面：消息提交/重新生成/停止与已删任务清洗；共享层、输入构建与轮次执行分别在
// agentOrchestratorShared.ts / agentOrchestratorInput.ts / agentOrchestratorRound.ts。
import type {
  AgentConversation,
  AgentMessage,
  AgentRound,
  ApiProfile,
  AppSettings,
  ResponsesApiResponse,
  ResponsesOutputItem,
  TaskRecord,
} from '../../types'
import { DEFAULT_PARAMS } from '../../types'
import { getActiveApiProfile, normalizeSettings, validateApiProfile } from '../shared/apiProfiles'
import { callAgentConversationTitleApi } from './agentApi'
import { orderInputImagesForMask } from '../imaging/mask'
import { validateMaskMatchesImage } from '../imaging/canvasImage'
import { normalizeParamsForSettings } from '../params/paramCompatibility'
import { getUserFacingErrorMessage } from '../shared/userFacingText'
import { storeImage } from '../shared/db'
import { cacheImage } from '../../store/imageCache'
import { getCachedAuthUser } from '../shared/auth'
import { logger } from '../shared/logger'
import {
  createAgentConversationTitle,
  getActiveAgentRounds,
  getAgentRoundPath,
} from './agentConversationTree'
import { getValidAgentTargetAssetSlotId, reconcileAgentAssetPlanWithTasks } from './agentPlatformContext'
import {
  agentRoundControllers,
  createSettingsForApiProfile,
  genId,
  getActiveAgentConversation,
  getAgentRoundControllerKey,
  getState,
  markAgentRoundStopped,
  putTask,
  readAgentImageDataUrls,
  setState,
  uniqueIds,
  updateAgentConversation,
} from './agentOrchestratorShared'
import { executeAgentRound } from './agentOrchestratorRound'

export { bindAgentOrchestrator, resolveAgentTaskPrompt } from './agentOrchestratorShared'
export type { AgentOrchestratorDeps } from './agentOrchestratorShared'

export {
  createAgentConversationTitle,
  deleteAgentRoundFromConversation,
  getActiveAgentRounds,
  getAgentBranchLeafId,
  getAgentRoundPath,
  getAgentSiblingRounds,
  remapAgentRoundMentionsForPathChange,
} from './agentConversationTree'

async function generateAgentConversationTitle(
  conversationId: string,
  prompt: string,
  inputImageIds: string[],
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  fallbackTitle: string,
) {
  setState((state) => {
    const next = { ...state.agentGeneratingTitleIds, [conversationId]: true as const }
    return { agentGeneratingTitleIds: next }
  })
  try {
    const imageDataUrls = await readAgentImageDataUrls(inputImageIds)
    const title = await callAgentConversationTitleApi({
      settings: requestSettings,
      profile: activeProfile,
      prompt,
      imageDataUrls,
    })
    if (!title || title === fallbackTitle) return

    updateAgentConversation(conversationId, (current) => {
      const firstRound = current.rounds[0]
      if (!firstRound || firstRound.prompt !== prompt || current.title !== fallbackTitle) return current
      return { ...current, title, updatedAt: Date.now() }
    })
  } catch {
    // Title generation is best-effort; keep the local fallback title on failure.
  } finally {
    setState((state) => {
      const next = { ...state.agentGeneratingTitleIds }
      delete next[conversationId]
      return { agentGeneratingTitleIds: next }
    })
  }
}

export function stopAgentResponse(conversationId = getState().activeAgentConversationId) {
  if (!conversationId) return
  const conversation = getState().agentConversations.find((item) => item.id === conversationId)
  if (!conversation) return
  const activeRunningRound = [...getActiveAgentRounds(conversation)].reverse().find((round) => round.status === 'running')
  const runningRound = activeRunningRound ?? conversation.rounds.find((round) => round.status === 'running')
  if (!runningRound) return

  const controller = agentRoundControllers.get(getAgentRoundControllerKey(conversationId, runningRound.id))
  if (controller) {
    controller.abort()
    if (markAgentRoundStopped(conversationId, runningRound.id)) {
      getState().showToast('已停止生成', 'info')
    }
    return
  }

  markAgentRoundStopped(conversationId, runningRound.id)
  getState().showToast('已停止生成', 'info')
}

function scrubResponseOutputForDeletedAgentTasks(round: AgentRound, output: ResponsesOutputItem[], deletedTasks: TaskRecord[]) {
  const deletedTaskIds = new Set(deletedTasks.map((task) => task.id))
  const deletedToolCallIds = new Set(
    deletedTasks
      .filter((task) => task.agentRoundId === round.id && task.agentToolCallId)
      .map((task) => task.agentToolCallId!),
  )
  if (deletedTaskIds.size === 0) return output

  let anonymousImageIndex = 0
  return output.filter((item) => {
    if (item.type !== 'image_generation_call') return true

    if (typeof item.id === 'string' && item.id) {
      return !deletedToolCallIds.has(item.id)
    }

    const taskId = round.outputTaskIds[anonymousImageIndex]
    anonymousImageIndex += 1
    if (taskId === undefined) return true
    return !deletedTaskIds.has(taskId)
  })
}

function scrubAgentConversationsForDeletedTasks(conversations: AgentConversation[], deletedTasks: TaskRecord[], remainingTasks: TaskRecord[]) {
  if (deletedTasks.length === 0) return conversations

  return conversations.map((conversation) => {
    const rounds = conversation.rounds.map((round) => {
      const roundDeletedTasks = deletedTasks.filter((task) => round.outputTaskIds.includes(task.id))
      if (roundDeletedTasks.length === 0 || !round.responseOutput?.length) return round
      return {
        ...round,
        responseOutput: scrubResponseOutputForDeletedAgentTasks(round, round.responseOutput, roundDeletedTasks),
      }
    })
    const assetPlan = reconcileAgentAssetPlanWithTasks(
      conversation.assetPlan,
      remainingTasks.filter((task) => task.agentConversationId === conversation.id),
    )
    return {
      ...conversation,
      ...(assetPlan ? { assetPlan } : {}),
      rounds,
    }
  })
}

function scrubTaskRawResponsePayloadForDeletedTasks(task: TaskRecord, conversations: AgentConversation[], deletedTasks: TaskRecord[]) {
  if (!task.rawResponsePayload || !task.agentRoundId) return task

  const round = conversations
    .flatMap((conversation) => conversation.rounds)
    .find((item) => item.id === task.agentRoundId)
  if (!round) return task

  const roundDeletedTasks = deletedTasks.filter((item) => round.outputTaskIds.includes(item.id))
  if (roundDeletedTasks.length === 0) return task

  try {
    const payload = JSON.parse(task.rawResponsePayload) as ResponsesApiResponse
    if (!Array.isArray(payload.output)) return task
    const output = scrubResponseOutputForDeletedAgentTasks(round, payload.output, roundDeletedTasks)
    if (output.length === payload.output.length) return task
    return { ...task, rawResponsePayload: JSON.stringify({ ...payload, output }, null, 2) }
  } catch {
    return task
  }
}

export async function scrubAgentOutputPayloadsForDeletedTasks(deletedTasks: TaskRecord[], remainingTasks: TaskRecord[]) {
  if (deletedTasks.length === 0) return remainingTasks

  const conversations = scrubAgentConversationsForDeletedTasks(getState().agentConversations, deletedTasks, remainingTasks)
  const scrubbedTasks = remainingTasks.map((task) => scrubTaskRawResponsePayloadForDeletedTasks(task, conversations, deletedTasks))
  setState({ agentConversations: conversations })

  for (const task of scrubbedTasks) {
    const previous = remainingTasks.find((item) => item.id === task.id)
    if (previous?.rawResponsePayload !== task.rawResponsePayload) await putTask(task)
  }

  return scrubbedTasks
}

export async function submitAgentMessage() {
  const state = getState()
  const { settings, prompt, inputImages, maskDraft, params, showToast } = state
  const normalizedSettings = normalizeSettings(settings)
  const activeProfile = getActiveApiProfile(normalizedSettings)

  const apiProfileError = validateApiProfile(activeProfile)
  if (apiProfileError) {
    showToast(`API 与模型配置未完成：${apiProfileError}`, 'error')
    state.setShowSettings(true)
    return
  }

  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    showToast('请输入消息', 'error')
    return
  }

  const conversation = getActiveAgentConversation()
  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast('请等待生成完成，或先停止生成', 'info')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        state.clearMaskDraft()
      }
      showToast(getUserFacingErrorMessage(err, '遮罩图片无效'), 'error')
      return
    }
  }

  const inputImageIds = uniqueIds(orderedInputImages.map((image) => image.id))
  const editingRound = state.agentEditingRoundId
    ? conversation.rounds.find((item) => item.id === state.agentEditingRoundId) ?? null
    : null
  const targetAssetSlotId = getValidAgentTargetAssetSlotId(conversation.platformId, state.agentTargetAssetSlotId)
    ?? getValidAgentTargetAssetSlotId(conversation.platformId, editingRound?.targetAssetSlotId)

  for (const image of orderedInputImages) {
    await storeImage(image.dataUrl)
  }

  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const now = Date.now()
  const editingRoundAssistantMessage = editingRound?.assistantMessageId
    ? conversation.messages.find((message) => message.id === editingRound.assistantMessageId) ?? null
    : conversation.messages.find((message) => message.roundId === editingRound?.id && message.role === 'assistant') ?? null
  const editingRoundHasAssistantMessage = Boolean(editingRoundAssistantMessage)
  const editingRoundHasErrorAssistantMessage = Boolean(
    editingRound?.status === 'error' && editingRoundAssistantMessage?.content.startsWith('请求失败：'),
  )
  const editingRoundHasChildren = editingRound
    ? conversation.rounds.some((round) => (round.parentRoundId ?? null) === editingRound.id)
    : false
  const shouldAppendToEditingRound = Boolean(
    editingRound && !editingRoundHasChildren && (!editingRoundHasAssistantMessage || editingRoundHasErrorAssistantMessage),
  )
  const roundId = shouldAppendToEditingRound && editingRound ? editingRound.id : genId()
  const userMessageId = shouldAppendToEditingRound && editingRound ? editingRound.userMessageId : genId()
  const activeRounds = getActiveAgentRounds(conversation)
  const activeLeafId = activeRounds[activeRounds.length - 1]?.id ?? null
  const parentRoundId = editingRound ? editingRound.parentRoundId ?? null : activeLeafId
  const parentPath = parentRoundId ? getAgentRoundPath(conversation, parentRoundId) : []
  const normalizedParams = {
    ...normalizeParamsForSettings(params, requestSettings, {
      hasInputImages: inputImageIds.length > 0,
      maxOutputImages: getCachedAuthUser()?.maxBatchImages,
    }),
    n: DEFAULT_PARAMS.n,
  }
  const round: AgentRound = {
    id: roundId,
    index: shouldAppendToEditingRound && editingRound ? editingRound.index : parentPath.length + 1,
    parentRoundId,
    ...(editingRoundHasErrorAssistantMessage && editingRoundAssistantMessage ? { assistantMessageId: editingRoundAssistantMessage.id } : {}),
    userMessageId,
    prompt: trimmedPrompt,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    outputTaskIds: [],
    stepType: targetAssetSlotId ? 'generate' : undefined,
    targetAssetSlotId,
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const userMessage: AgentMessage = {
    id: userMessageId,
    role: 'user',
    content: trimmedPrompt,
    roundId,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    createdAt: now,
  }

  let fallbackTitle: string | null = null
  updateAgentConversation(conversation.id, (current) => {
    const nextTitle = current.rounds.length === 0 ? createAgentConversationTitle(trimmedPrompt, current.title) : current.title
    if (current.rounds.length === 0) fallbackTitle = nextTitle
    const messages = shouldAppendToEditingRound
      ? current.messages.some((message) => message.id === userMessageId)
        ? current.messages.map((message) => {
            if (message.id === userMessageId) return userMessage
            if (editingRoundHasErrorAssistantMessage && message.id === editingRoundAssistantMessage?.id) {
              return { ...message, content: '', outputTaskIds: [] }
            }
            return message
          })
        : [...current.messages, userMessage]
      : [...current.messages, userMessage]

    return {
      ...current,
      title: nextTitle,
      activeRoundId: roundId,
      updatedAt: now,
      rounds: shouldAppendToEditingRound
        ? current.rounds.map((item) => item.id === roundId ? round : item)
        : [...current.rounds, round],
      messages,
    }
  })

  logger.info('agent', 'Agent 用户消息已提交', {
    appMode: 'agent',
    conversationId: conversation.id,
    roundId,
    inputImages: inputImageIds.length,
    mask: Boolean(maskImageId),
    promptChars: trimmedPrompt.length,
    editing: Boolean(editingRound),
  })

  state.setPrompt('')
  state.clearInputImages()
  state.clearMaskDraft()
  state.setAgentEditingRoundId(null)
  state.setAgentTargetAssetSlotId(null)

  if (fallbackTitle) {
    void generateAgentConversationTitle(conversation.id, trimmedPrompt, inputImageIds, requestSettings, activeProfile, fallbackTitle)
  }

  void executeAgentRound(conversation.id, roundId, normalizedParams, requestSettings, activeProfile)
}

export async function regenerateAgentAssistantMessage(conversationId: string, roundId: string) {
  const state = getState()
  const { settings, params, showToast } = state
  const normalizedSettings = normalizeSettings(settings)
  const activeProfile = getActiveApiProfile(normalizedSettings)

  const apiProfileError = validateApiProfile(activeProfile)
  if (apiProfileError) {
    showToast(`API 与模型配置未完成：${apiProfileError}`, 'error')
    state.setShowSettings(true)
    return
  }

  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const sourceRound = conversation?.rounds.find((item) => item.id === roundId) ?? null
  const sourceUserMessage = sourceRound
    ? conversation?.messages.find((message) => message.id === sourceRound.userMessageId) ?? null
    : null
  if (!conversation || !sourceRound || !sourceUserMessage) {
    showToast('找不到要重新生成的 Agent 消息', 'error')
    return
  }

  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast('请等待生成完成，或先停止生成', 'info')
    return
  }

  const inputImageIds = uniqueIds(sourceRound.inputImageIds)
  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const normalizedParams = {
    ...normalizeParamsForSettings(params, requestSettings, {
      hasInputImages: inputImageIds.length > 0,
      maxOutputImages: getCachedAuthUser()?.maxBatchImages,
    }),
    n: DEFAULT_PARAMS.n,
  }
  const now = Date.now()
  if (sourceRound.status === 'error') {
    const assistantMessageId = sourceRound.assistantMessageId
      ?? conversation.messages.find((message) => message.roundId === sourceRound.id && message.role === 'assistant')?.id
    updateAgentConversation(conversationId, (current) => ({
      ...current,
      activeRoundId: sourceRound.id,
      updatedAt: now,
      rounds: current.rounds.map((round) =>
        round.id === sourceRound.id
          ? {
              ...round,
              outputTaskIds: [],
              responseId: undefined,
              responseOutput: undefined,
              status: 'running',
              error: null,
              finishedAt: null,
            }
          : round,
      ),
      messages: assistantMessageId
        ? current.messages.map((message) =>
            message.id === assistantMessageId ? { ...message, content: '', outputTaskIds: [] } : message,
          )
        : current.messages,
    }))
    state.setAgentEditingRoundId(null)
    void executeAgentRound(conversationId, sourceRound.id, normalizedParams, requestSettings, activeProfile)
    return
  }

  const newRoundId = genId()
  const newUserMessageId = genId()
  const newRound: AgentRound = {
    id: newRoundId,
    index: sourceRound.index,
    parentRoundId: sourceRound.parentRoundId ?? null,
    userMessageId: newUserMessageId,
    prompt: sourceRound.prompt || sourceUserMessage.content.trim(),
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    outputTaskIds: [],
    stepType: sourceRound.stepType,
    targetAssetSlotId: sourceRound.targetAssetSlotId ?? null,
    ...(Array.isArray(sourceRound.platformNotes) ? { platformNotes: [...sourceRound.platformNotes] } : {}),
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const newUserMessage: AgentMessage = {
    id: newUserMessageId,
    role: 'user',
    content: sourceUserMessage.content,
    roundId: newRoundId,
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    createdAt: now,
  }

  updateAgentConversation(conversationId, (current) => ({
    ...current,
    activeRoundId: newRoundId,
    updatedAt: now,
    rounds: [...current.rounds, newRound],
    messages: [...current.messages, newUserMessage],
  }))
  state.setAgentEditingRoundId(null)
  void executeAgentRound(conversationId, newRoundId, normalizedParams, requestSettings, activeProfile)
}
