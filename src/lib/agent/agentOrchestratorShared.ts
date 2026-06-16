// Agent 编排共享层：store 依赖绑定、状态访问器与轮次停止/中止等共用 helpers（从 agentOrchestrator.ts 拆出）。
import type {
  AgentConversation,
  ApiProfile,
  AppMode,
  AppSettings,
  InputImage,
  MaskDraft,
  TaskParams,
  TaskRecord,
} from '../../types'
import { ensureImageCached } from '../../store/imageCache'
import { finalizeAgentAssetPlanSlotStatus } from './agentPlatformContext'

export const AGENT_STOPPED_MESSAGE = '已停止生成。'
export const agentRoundControllers = new Map<string, AbortController>()

type AppStateSlice = {
  appMode: AppMode
  settings: AppSettings
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  params: TaskParams
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void
  setShowSettings: (show: boolean) => void
  setAppMode: (mode: AppMode) => void
  setPrompt: (prompt: string) => void
  clearInputImages: () => void
  clearMaskDraft: () => void
  setAgentEditingRoundId: (id: string | null) => void
  agentEditingRoundId: string | null
  agentTargetAssetSlotId: string | null
  setAgentTargetAssetSlotId: (id: string | null) => void
  agentConversations: AgentConversation[]
  activeAgentConversationId: string | null
  createAgentConversation: () => string
  tasks: TaskRecord[]
  setTasks: (tasks: TaskRecord[]) => void
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void
  agentGeneratingTitleIds: Record<string, true>
}

export interface AgentOrchestratorDeps {
  getState: () => AppStateSlice
  setState: (partial: unknown) => void
  updateTaskInStore: (taskId: string, patch: Partial<TaskRecord>) => void
  genId: () => string
  putTask: (task: TaskRecord) => Promise<IDBValidKey>
  createSettingsForApiProfile: (settings: AppSettings, profile: ApiProfile) => AppSettings
  persistTaskStreamPartialImage: (taskId: string, dataUrl: string) => Promise<void>
}

let deps: AgentOrchestratorDeps

export function bindAgentOrchestrator(next: AgentOrchestratorDeps) {
  deps = next
}

export function getState() {
  if (!deps) throw new Error('Agent 运行模块尚未初始化，请刷新页面后重试。')
  return deps.getState()
}

export function setState(partial: Partial<AppStateSlice> | ((state: AppStateSlice) => Partial<AppStateSlice>)) {
  deps.setState(partial)
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  deps.updateTaskInStore(taskId, patch)
}

export function genId() {
  return deps.genId()
}

export function putTask(task: TaskRecord) {
  return deps.putTask(task)
}

export function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile) {
  return deps.createSettingsForApiProfile(settings, profile)
}

export function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  return deps.persistTaskStreamPartialImage(taskId, dataUrl)
}

export function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)))
}

export function resolveAgentTaskPrompt(taskPrompt?: string | null, roundPrompt?: string | null, messagePrompt?: string | null) {
  return (taskPrompt?.trim() || roundPrompt?.trim() || messagePrompt?.trim() || '')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getActiveAgentConversation(): AgentConversation {
  const state = getState()
  const existing = state.agentConversations.find((conversation) => conversation.id === state.activeAgentConversationId)
  if (existing) return existing

  const id = state.createAgentConversation()
  return getState().agentConversations.find((conversation) => conversation.id === id)!
}

export function updateAgentConversation(conversationId: string, updater: (conversation: AgentConversation) => AgentConversation) {
  setState((state) => ({
    agentConversations: state.agentConversations.map((conversation) =>
      conversation.id === conversationId ? updater(conversation) : conversation,
    ),
  }))
}

export function getAgentRoundControllerKey(conversationId: string, roundId: string) {
  return `${conversationId}:${roundId}`
}

export function createAgentAbortError() {
  return new DOMException('Agent 请求已停止', 'AbortError')
}

function appendAgentStoppedMessage(content: string) {
  const trimmed = content.trimEnd()
  if (!trimmed) return AGENT_STOPPED_MESSAGE
  if (trimmed.endsWith(AGENT_STOPPED_MESSAGE)) return trimmed
  return `${trimmed}\n\n${AGENT_STOPPED_MESSAGE}`
}

function markAgentRoundTasksStopped(conversationId: string, roundId: string, now = Date.now()) {
  const runningTasks = getState().tasks.filter((task) =>
    task.status === 'running' &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId,
  )

  for (const task of runningTasks) {
    updateTaskInStore(task.id, {
      status: 'error',
      error: AGENT_STOPPED_MESSAGE,
      customRecoverable: false,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    })
  }
  return runningTasks.length > 0
}

export function markAgentRoundStopped(conversationId: string, roundId: string) {
  const now = Date.now()
  const stoppedTasks = markAgentRoundTasksStopped(conversationId, roundId, now)
  let stoppedRound = false
  updateAgentConversation(conversationId, (current) => {
    const round = current.rounds.find((item) => item.id === roundId)
    if (!round || round.status !== 'running') return current

    stoppedRound = true
    const existingAssistantMessage = current.messages.find((message) => message.roundId === roundId && message.role === 'assistant')
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    const assetPlan = finalizeAgentAssetPlanSlotStatus(current.assetPlan, round.targetAssetSlotId, getState().tasks)
    return {
      ...current,
      ...(assetPlan ? { assetPlan } : {}),
      updatedAt: now,
      rounds: current.rounds.map((item) =>
        item.id === roundId
          ? {
              ...item,
              ...(assistantMessageId ? { assistantMessageId } : {}),
              status: 'error',
              error: AGENT_STOPPED_MESSAGE,
              finishedAt: now,
            }
          : item,
      ),
      messages: existingAssistantMessage
        ? current.messages.map((message) =>
            message.id === existingAssistantMessage.id
              ? { ...message, content: appendAgentStoppedMessage(message.content) }
              : message,
          )
        : [
            ...current.messages,
            {
              id: assistantMessageId,
              role: 'assistant',
              content: AGENT_STOPPED_MESSAGE,
              roundId,
              createdAt: now,
            },
          ],
    }
  })
  return stoppedRound || stoppedTasks
}

export function appendAgentAssistantMessageContent(conversationId: string, messageId: string, delta: string) {
  if (!delta) return
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    messages: current.messages.map((message) =>
      message.id === messageId
        ? { ...message, content: `${message.content}${delta}` }
        : message,
    ),
  }))
}

export async function readAgentImageDataUrls(ids: string[]) {
  const dataUrls: string[] = []
  for (const id of ids) {
    const dataUrl = await ensureImageCached(id)
    if (dataUrl) dataUrls.push(dataUrl)
  }
  return dataUrls
}
