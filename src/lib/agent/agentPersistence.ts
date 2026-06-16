import type {
  AgentConversation,
  AgentMessage,
  AgentPlatformAssetPlanItem,
  AgentPlatformBrief,
  AgentRound,
  ResponsesOutputItem,
} from '../../types'
import { normalizeAgentPlatformId } from '../platforms/registry'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  const items = normalizeStringArray(value).map((item) => item.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function normalizeAgentPlatformBrief(value: unknown): AgentPlatformBrief | undefined {
  if (!isRecord(value)) return undefined
  const brief: AgentPlatformBrief = {}
  const productName = normalizeOptionalString(value.productName)
  const category = normalizeOptionalString(value.category)
  const targetMarket = normalizeOptionalString(value.targetMarket)
  const audience = normalizeOptionalString(value.audience)
  const brandTone = normalizeOptionalString(value.brandTone)
  const sourceUrl = normalizeOptionalString(value.sourceUrl)
  const locale = normalizeOptionalString(value.locale)
  const sellingPoints = normalizeOptionalStringArray(value.sellingPoints)
  const restrictions = normalizeOptionalStringArray(value.restrictions)
  if (productName) brief.productName = productName
  if (category) brief.category = category
  if (targetMarket) brief.targetMarket = targetMarket
  if (audience) brief.audience = audience
  if (brandTone) brief.brandTone = brandTone
  if (sourceUrl) brief.sourceUrl = sourceUrl
  if (locale) brief.locale = locale
  if (sellingPoints) brief.sellingPoints = sellingPoints
  if (restrictions) brief.restrictions = restrictions
  return Object.keys(brief).length ? brief : undefined
}

function normalizeAssetPlanStatus(value: unknown): AgentPlatformAssetPlanItem['status'] {
  return value === 'generating' || value === 'ready' || value === 'needs_revision' ? value : 'planned'
}

function normalizeAgentAssetPlan(value: unknown): AgentPlatformAssetPlanItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter(isRecord)
    .map((item): AgentPlatformAssetPlanItem | null => {
      const slotId = normalizeOptionalString(item.slotId)
      if (!slotId) return null
      const promptHint = normalizeOptionalString(item.promptHint)
      const approvedTaskId = normalizeOptionalString(item.approvedTaskId)
      const notes = normalizeOptionalString(item.notes)
      return {
        slotId,
        status: normalizeAssetPlanStatus(item.status),
        taskIds: normalizeStringArray(item.taskIds),
        ...(promptHint ? { promptHint } : {}),
        ...(approvedTaskId ? { approvedTaskId } : {}),
        ...(notes ? { notes } : {}),
      }
    })
    .filter((item): item is AgentPlatformAssetPlanItem => Boolean(item))
  return items.length ? items : undefined
}

function normalizeAgentRound(value: unknown, fallbackIndex: number): AgentRound | null {
  if (!value || typeof value !== 'object') return null
  const round = value as Partial<AgentRound>
  if (typeof round.id !== 'string' || !round.id) return null
  if (typeof round.userMessageId !== 'string' || !round.userMessageId) return null

  const status = round.status === 'running'
    ? 'error'
    : round.status === 'error' || round.status === 'done'
    ? round.status
    : 'done'

  return {
    id: round.id,
    index: typeof round.index === 'number' ? round.index : fallbackIndex + 1,
    parentRoundId: typeof round.parentRoundId === 'string' ? round.parentRoundId : null,
    userMessageId: round.userMessageId,
    ...(typeof round.assistantMessageId === 'string' ? { assistantMessageId: round.assistantMessageId } : {}),
    prompt: typeof round.prompt === 'string' ? round.prompt : '',
    inputImageIds: normalizeStringArray(round.inputImageIds),
    maskTargetImageId: typeof round.maskTargetImageId === 'string' ? round.maskTargetImageId : null,
    maskImageId: typeof round.maskImageId === 'string' ? round.maskImageId : null,
    outputTaskIds: normalizeStringArray(round.outputTaskIds),
    ...(typeof round.responseId === 'string' ? { responseId: round.responseId } : {}),
    ...(Array.isArray(round.responseOutput) ? { responseOutput: round.responseOutput } : {}),
    ...(round.stepType === 'brief' || round.stepType === 'plan' || round.stepType === 'generate' || round.stepType === 'revise' || round.stepType === 'validate' || round.stepType === 'export'
      ? { stepType: round.stepType }
      : {}),
    targetAssetSlotId: typeof round.targetAssetSlotId === 'string' ? round.targetAssetSlotId : null,
    ...(Array.isArray(round.platformNotes) ? { platformNotes: normalizeStringArray(round.platformNotes) } : {}),
    status,
    error: status === 'error'
      ? typeof round.error === 'string' ? round.error : '上次请求已中断'
      : null,
    createdAt: typeof round.createdAt === 'number' ? round.createdAt : Date.now(),
    finishedAt: typeof round.finishedAt === 'number' ? round.finishedAt : null,
  }
}

function normalizeAgentMessage(value: unknown): AgentMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<AgentMessage>
  if (typeof message.id !== 'string' || !message.id) return null
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (typeof message.roundId !== 'string' || !message.roundId) return null

  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    roundId: message.roundId,
    ...(Array.isArray(message.inputImageIds) ? { inputImageIds: normalizeStringArray(message.inputImageIds) } : {}),
    maskTargetImageId: typeof message.maskTargetImageId === 'string' ? message.maskTargetImageId : null,
    maskImageId: typeof message.maskImageId === 'string' ? message.maskImageId : null,
    ...(Array.isArray(message.outputTaskIds) ? { outputTaskIds: normalizeStringArray(message.outputTaskIds) } : {}),
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
  }
}

export function normalizeAgentConversations(value: unknown): AgentConversation[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((item): item is AgentConversation => Boolean(item) && typeof item === 'object' && typeof (item as AgentConversation).id === 'string')
    .map((conversation) => {
      const normalizedRounds = Array.isArray(conversation.rounds)
        ? conversation.rounds.map(normalizeAgentRound).filter((round): round is AgentRound => Boolean(round))
        : []
      const hasBranchParents = normalizedRounds.some((round) => round.parentRoundId)
      const hasStoredActiveRound = typeof conversation.activeRoundId === 'string'
      const rounds = hasBranchParents || hasStoredActiveRound
        ? normalizedRounds
        : normalizedRounds.map((round, index) => ({
            ...round,
            parentRoundId: index > 0 ? normalizedRounds[index - 1].id : null,
          }))
      const roundIds = new Set(rounds.map((round) => round.id))
      const messages = Array.isArray(conversation.messages)
        ? conversation.messages
            .map(normalizeAgentMessage)
            .filter((message): message is AgentMessage => message != null && roundIds.has(message.roundId))
        : []
      const platformBrief = normalizeAgentPlatformBrief(conversation.platformBrief)
      const assetPlan = normalizeAgentAssetPlan(conversation.assetPlan)
      return {
        id: conversation.id,
        title: typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title : '新对话',
        platformId: normalizeAgentPlatformId(conversation.platformId),
        ...(platformBrief ? { platformBrief } : {}),
        ...(assetPlan ? { assetPlan } : {}),
        activeRoundId: typeof conversation.activeRoundId === 'string' && roundIds.has(conversation.activeRoundId) ? conversation.activeRoundId : rounds[rounds.length - 1]?.id ?? null,
        createdAt: typeof conversation.createdAt === 'number' ? conversation.createdAt : Date.now(),
        updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : Date.now(),
        rounds,
        messages,
      }
    })
}

export function mergeImportedAgentConversations(current: AgentConversation[], imported: AgentConversation[]) {
  const merged = [...current]
  const indexes = new Map(merged.map((conversation, index) => [conversation.id, index]))

  for (const conversation of imported) {
    const index = indexes.get(conversation.id)
    if (index == null) {
      indexes.set(conversation.id, merged.length)
      merged.push(conversation)
    } else {
      merged[index] = conversation
    }
  }

  return merged
}

export function mergeAgentConversationsForStorage(stored: AgentConversation[], legacy: AgentConversation[]) {
  const merged = new Map<string, AgentConversation>()
  for (const conversation of stored) merged.set(conversation.id, conversation)
  for (const conversation of legacy) {
    const existing = merged.get(conversation.id)
    if (!existing || conversation.updatedAt >= existing.updatedAt) {
      merged.set(conversation.id, conversation)
    }
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}

function getPersistableResponseOutputItem(item: ResponsesOutputItem): ResponsesOutputItem {
  if (item.type !== 'image_generation_call' || item.result == null) return item

  if (typeof item.result === 'string') {
    const { result: _result, ...rest } = item
    return rest
  }

  if (!isRecord(item.result)) return item
  const { b64_json: _b64Json, base64: _base64, image: _image, data: _data, ...restResult } = item.result
  if (Object.keys(restResult).length === 0) {
    const { result: _result, ...rest } = item
    return rest
  }

  return { ...item, result: restResult }
}

export function getPersistableAgentConversations(conversations: AgentConversation[]): AgentConversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    rounds: conversation.rounds.map((round) => round.responseOutput?.length
      ? {
          ...round,
          responseOutput: round.responseOutput.map(getPersistableResponseOutputItem),
        }
      : round,
    ),
  }))
}

function stripPersistedAgentConversations(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((conversation) => {
    if (!isRecord(conversation) || !Array.isArray(conversation.rounds)) return conversation
    return {
      ...conversation,
      rounds: conversation.rounds.map((round) => {
        if (!isRecord(round) || !Array.isArray(round.responseOutput)) return round
        return {
          ...round,
          responseOutput: round.responseOutput.map((item) =>
            isRecord(item) ? getPersistableResponseOutputItem(item as ResponsesOutputItem) : item,
          ),
        }
      }),
    }
  })
}

export function migratePersistedState(persistedState: unknown): unknown {
  if (!isRecord(persistedState)) return persistedState
  return {
    ...persistedState,
    agentConversations: stripPersistedAgentConversations(persistedState.agentConversations),
  }
}

export function isEmptyAgentConversation(conversation: AgentConversation) {
  return conversation.rounds.length === 0 && conversation.messages.length === 0 && !conversation.activeRoundId
}

export function getPersistableAgentConversation(conversation: AgentConversation): AgentConversation {
  return getPersistableAgentConversations([conversation])[0]!
}

export function getPersistableRawResponsePayload(rawResponsePayload?: string) {
  if (!rawResponsePayload) return rawResponsePayload
  try {
    const payload = JSON.parse(rawResponsePayload) as { output?: unknown }
    if (!Array.isArray(payload.output)) return rawResponsePayload
    const output = payload.output.map((item) =>
      isRecord(item) ? getPersistableResponseOutputItem(item as ResponsesOutputItem) : item,
    )
    return JSON.stringify({ ...payload, output }, null, 2)
  } catch {
    return rawResponsePayload
  }
}
