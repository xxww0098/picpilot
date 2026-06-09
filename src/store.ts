import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getCachedAuthUser, namespacedStorageKey } from './lib/auth'
import type {
  AgentConversation,
  ApiProfile,
  AppSettings,
  AppMode,
  MultiImageMode,
  TaskParams,
  TaskImageSource,
  InputImage,
  MaskDraft,
  TaskRecord,
  UpstreamMode,
  ExportData,
} from './types'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, DEFAULT_VIDEO_DURATION_SECONDS, DEFAULT_VIDEO_MODEL, getActiveApiProfile, getCustomProviderDefinition, mergeImportedSettings, normalizeSettings, normalizeVideoDurationSeconds, validateApiProfile } from './lib/apiProfiles'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { fetchQueueStats, type QueueStats } from './lib/queueApi'
import { remapImageMentionsForOrder, replaceImageMentionsForApi } from './lib/promptImageMentions'
import {
  getAllTasks,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  getAllAgentConversations,
  replaceAgentConversations,
  clearAgentConversations as dbClearAgentConversations,
  getImage,
  getImageThumbnail,
  getAllImageIds,
  getAllImages,
  putImage,
  putImageThumbnail,
  deleteImage,
  clearImages,
  putVideo as dbPutVideo,
  deleteVideo,
  clearVideos,
  getAllVideos,
  storeImage,
} from './lib/db'
import { callImageApi, type CallApiOptions, type CallApiResult } from './lib/api'
import { logger, serializeError } from './lib/logger'
import { getImageApiFanoutConcurrency, IMAGE_FETCH_CORS_HINT, isApiTimeoutError } from './lib/imageApiShared'
import { settleWithConcurrency } from './lib/runWithConcurrency'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { getErrorToastMessage } from './lib/errorToast'
import { getUserFacingErrorMessage } from './lib/userFacingText'
import {
  getPersistableAgentConversation,
  getPersistableAgentConversations,
  isEmptyAgentConversation,
  mergeAgentConversationsForStorage,
  mergeImportedAgentConversations,
  migratePersistedState,
  normalizeAgentConversations,
} from './lib/agentPersistence'
import { bytesToDataUrl, dataUrlToBytes, formatExportFileTime } from './lib/exportZip'
import {
  createOpenAITimeoutError,
  getApiRequestNetworkErrorHint,
  getUpstreamApiErrorHint,
  isRecoverableConnectionError,
  type TimeoutStreamingHintProfile,
} from './lib/taskErrorHints'
import { fileToDataUrl, readBlobAsDataUrl } from './lib/dataUrl'
import { preprocessImageFile } from './lib/imagePreprocess'
import {
  bindAgentOrchestrator,
  scrubAgentOutputPayloadsForDeletedTasks,
} from './lib/agentOrchestrator'
import {
  firstActualParams,
  getPersistableTask,
  isAsyncCustomProviderTask,
  isRunningOpenAITask,
  mapActualParamsByImage,
  putTask,
  readImageSizeParamsList,
} from './lib/taskPersistence'
import {
  cacheImage,
  cacheThumbnail,
  clearImageCaches,
  ensureImageCached,
  evictCachedImage,
  resetImageCacheEntry,
  scheduleThumbnailBackfill,
} from './store/imageCache'
import { generateVideo } from './lib/videoApi'
import { applyTeamRuntimeSettings, isTeamStreamFallbackEnabled } from './lib/runtimeTeamSettings'

export { getErrorToastMessage } from './lib/errorToast'
export { migratePersistedState } from './lib/agentPersistence'
export {
  deleteAgentRoundFromConversation,
  getActiveAgentRounds,
  getAgentBranchLeafId,
  getAgentRoundPath,
  getAgentSiblingRounds,
  remapAgentRoundMentionsForPathChange,
  regenerateAgentAssistantMessage,
  scrubAgentOutputPayloadsForDeletedTasks,
  stopAgentResponse,
  submitAgentMessage,
} from './lib/agentOrchestrator'
export {
  ensureImageCached,
  ensureImageThumbnailCached,
  getCachedImage,
  subscribeImageThumbnail,
} from './store/imageCache'

const CUSTOM_RECOVERY_POLL_MS = 10_000
const AGENT_INPUT_DRAFT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const failedImageRetryLocks = new Set<string>()
let agentConversationPersistenceReady = false

function uint8ToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
let agentConversationMigrationPending = false
const OPENAI_INTERRUPTED_ERROR = '请求中断'
type ToastType = 'info' | 'success' | 'error'
type AgentInputDraft = {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  updatedAt?: number
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

export type SettingsTab = 'general' | 'agent' | 'api' | 'data' | 'about'

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

export interface GalleryFilter {
  searchQuery: string
  filterStatus: 'all' | 'running' | 'done' | 'error'
  filterFavorite: boolean
}

// 画廊（历史）显示用的过滤 + 排序，TaskGrid 与「下载画廊图片」共用，保证下载与界面一致
export function filterGalleryTasks(tasks: TaskRecord[], filter: GalleryFilter): TaskRecord[] {
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  const q = filter.searchQuery.trim().toLowerCase()
  return sorted.filter((t) => {
    if (filter.filterFavorite && !t.isFavorite) return false
    if (!(filter.filterStatus === 'all' || t.status === filter.filterStatus)) return false
    if (!q) return true
    const prompt = (t.prompt || '').toLowerCase()
    const paramStr = JSON.stringify(t.params).toLowerCase()
    return prompt.includes(q) || paramStr.includes(q)
  })
}

// 当前画廊界面显示的全部输出图片 id（按显示顺序）
export function getGalleryDisplayedImageIds(
  state: Pick<AppState, 'tasks' | 'searchQuery' | 'filterStatus' | 'filterFavorite'>,
): string[] {
  return filterGalleryTasks(state.tasks, {
    searchQuery: state.searchQuery,
    filterStatus: state.filterStatus,
    filterFavorite: state.filterFavorite,
  }).flatMap((t) => t.outputImages)
}

function createAgentConversation(now = Date.now()): AgentConversation {
  return {
    id: genId(),
    title: '新对话',
    activeRoundId: null,
    createdAt: now,
    updatedAt: now,
    rounds: [],
    messages: [],
  }
}


function getLatestAgentConversation(conversations: AgentConversation[]) {
  return conversations.reduce<AgentConversation | null>((latest, conversation) => {
    if (!latest) return conversation
    if (conversation.updatedAt !== latest.updatedAt) return conversation.updatedAt > latest.updatedAt ? conversation : latest
    return conversation.createdAt > latest.createdAt ? conversation : latest
  }, null)
}

export function getPersistedState(state: AppState) {
  const settings = normalizeSettings(state.settings)
  const galleryInputDraft = getPersistableGalleryInputDraft(state)
  return {
    settings,
    params: state.params,
    ...(settings.persistInputOnRestart && (state.appMode === 'gallery' || state.appMode === 'video' || galleryInputDraft)
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) ?? [],
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    appMode: state.appMode,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) }
      : null,
    ...(agentConversationMigrationPending && !agentConversationPersistenceReady
      ? { agentConversations: getPersistableAgentConversations(state.agentConversations) }
      : {}),
    activeAgentConversationId: state.activeAgentConversationId,
    agentInputDrafts: getPersistableAgentInputDrafts(state),
    agentSidebarCollapsed: state.agentSidebarCollapsed,
    agentAssetTab: state.agentAssetTab,
    agentAssetPanelCollapsed: state.agentAssetPanelCollapsed,
  }
}

async function replaceStoredAgentConversations(conversations: AgentConversation[]) {
  await replaceAgentConversations(conversations.map(getPersistableAgentConversation))
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  if (!persistedState || typeof persistedState !== 'object') return currentState

  const persisted = persistedState as Partial<AppState>
  const settings = normalizeSettings(persisted.settings ?? currentState.settings)
  const hasPersistedAgentConversations = Array.isArray(persisted.agentConversations)
  if (hasPersistedAgentConversations && normalizeAgentConversations(persisted.agentConversations).length > 0) {
    agentConversationMigrationPending = true
  }
  const agentConversations = hasPersistedAgentConversations
    ? normalizeAgentConversations(persisted.agentConversations)
    : currentState.agentConversations
  const activeAgentConversationId =
    typeof persisted.activeAgentConversationId === 'string' && (!hasPersistedAgentConversations || agentConversations.some((conversation) => conversation.id === persisted.activeAgentConversationId))
      ? persisted.activeAgentConversationId
      : agentConversations[0]?.id ?? null
  const appMode = persisted.appMode === 'agent' || persisted.appMode === 'video' || persisted.appMode === 'workflow' ? persisted.appMode : 'gallery'
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeAgentInputDraft(persisted.galleryInputDraft ?? {
        prompt: persisted.prompt,
        inputImages: persisted.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      })
    : null
  const normalizedAgentInputDrafts = hasPersistedAgentConversations
    ? normalizeAgentInputDrafts(persisted.agentInputDrafts, agentConversations)
    : normalizeAgentInputDraftsByKey(persisted.agentInputDrafts)
  let agentInputDrafts = cleanStaleAgentInputDrafts(normalizedAgentInputDrafts, activeAgentConversationId)
  if (appMode === 'agent' && activeAgentConversationId && !agentInputDrafts[activeAgentConversationId] && settings.persistInputOnRestart && typeof persisted.prompt === 'string') {
    agentInputDrafts = {
      ...agentInputDrafts,
      [activeAgentConversationId]: normalizeAgentInputDraft({
        prompt: persisted.prompt,
        inputImages: persisted.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, Date.now()),
    }
  }
  const restoredAgentDraft = appMode === 'agent' && activeAgentConversationId
    ? agentInputDrafts[activeAgentConversationId] ?? null
    : null
  return {
    ...currentState,
    ...persisted,
    settings,
    appMode,
    galleryInputDraft: galleryInputDraft && !isEmptyAgentInputDraft(galleryInputDraft) ? galleryInputDraft : null,
    agentConversations,
    activeAgentConversationId,
    agentInputDrafts,
    agentSidebarCollapsed: Boolean(persisted.agentSidebarCollapsed),
    agentAssetTab: persisted.agentAssetTab === 'references' ? 'references' : 'outputs',
    agentAssetPanelCollapsed: Boolean(persisted.agentAssetPanelCollapsed),
    prompt: restoredAgentDraft ? restoredAgentDraft.prompt : galleryInputDraft?.prompt ?? '',
    inputImages: restoredAgentDraft ? restoredAgentDraft.inputImages : galleryInputDraft?.inputImages ?? [],
    maskDraft: restoredAgentDraft ? restoredAgentDraft.maskDraft : galleryInputDraft?.maskDraft ?? null,
    maskEditorImageId: restoredAgentDraft ? restoredAgentDraft.maskEditorImageId : galleryInputDraft?.maskEditorImageId ?? null,
  }
}

// ===== Store 类型 =====

export interface AppState {
  // 模式
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  replaceInputImage: (idx: number, img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  galleryInputDraft: AgentInputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null) => void

  // Agent
  agentConversations: AgentConversation[]
  agentConversationsLoaded: boolean
  activeAgentConversationId: string | null
  agentInputDrafts: Record<string, AgentInputDraft>
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  agentMobileHeaderVisible: boolean
  agentEditingRoundId: string | null
  agentEditingConversationId: string | null
  agentGeneratingTitleIds: Record<string, true>
  createAgentConversation: () => string
  setActiveAgentConversationId: (id: string | null) => void
  setActiveAgentRoundId: (conversationId: string, roundId: string | null) => void
  renameAgentConversation: (id: string, title: string) => void
  deleteAgentConversation: (id: string) => void
  setAgentSidebarCollapsed: (collapsed: boolean) => void
  setAgentAssetTab: (tab: 'references' | 'outputs') => void
  setAgentAssetPanelCollapsed: (collapsed: boolean) => void
  setAgentMobileHeaderVisible: (visible: boolean) => void
  setAgentEditingRoundId: (id: string | null) => void
  setAgentEditingConversationId: (id: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void
  regeneratingImageSlots: Record<string, number>
  regeneratingImageSlotLabels: Record<string, string>
  setRegeneratingImageSlot: (taskId: string, imageIndex: number | null, label?: string) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  showLogPanel: boolean
  setShowLogPanel: (v: boolean) => void

  // Queue stats（后端全局排队深度快照，由 QueueBanner 轮询写入；瞬时态，不持久化）
  queueStats: QueueStats | null
  setQueueStats: (stats: QueueStats | null) => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Prompt dialog
  promptDialog: {
    title: string
    message?: string
    defaultValue?: string
    inputType?: 'text' | 'password' | 'number'
    placeholder?: string
    confirmText?: string
    cancelText?: string
    validate?: (value: string) => string | null
    onConfirm: (value: string) => void
    onCancel?: () => void
  } | null
  setPromptDialog: (d: AppState['promptDialog']) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action?: (checkboxChecked?: boolean) => void
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.inputImages.some((img) => img.id === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId)) return true
  if (Object.values(state.agentInputDrafts).some((draft) => draft.inputImages.some((img) => img.id === imageId))) return true
  if (state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId
  )) return true
  return state.agentConversations.some((conversation) =>
    conversation.rounds.some((round) =>
      round.inputImageIds.includes(imageId) ||
      round.maskTargetImageId === imageId ||
      round.maskImageId === imageId
    ) ||
    conversation.messages.some((message) =>
      message.inputImageIds?.includes(imageId) ||
      message.maskTargetImageId === imageId ||
      message.maskImageId === imageId
    ),
  )
}

export async function deleteImageIfUnreferenced(imageId: string) {
  resetImageCacheEntry(imageId)
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteImage(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeInputImages(value: unknown): InputImage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((img): InputImage | null => {
      if (!isRecord(img) || typeof img.id !== 'string') return null
      return { id: img.id, dataUrl: typeof img.dataUrl === 'string' ? img.dataUrl : '' }
    })
    .filter((img): img is InputImage => img != null)
}

function normalizeMaskDraft(value: unknown): MaskDraft | null {
  if (!isRecord(value)) return null
  if (typeof value.targetImageId !== 'string' || typeof value.maskDataUrl !== 'string') return null
  return {
    targetImageId: value.targetImageId,
    maskDataUrl: value.maskDataUrl,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

function normalizeAgentInputDraft(value: unknown, fallbackUpdatedAt = Date.now()): AgentInputDraft {
  const draft = isRecord(value) ? value : {}
  const updatedAt = typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt) ? draft.updatedAt : fallbackUpdatedAt
  return {
    prompt: typeof draft.prompt === 'string' ? draft.prompt : '',
    inputImages: normalizeInputImages(draft.inputImages),
    maskDraft: normalizeMaskDraft(draft.maskDraft),
    maskEditorImageId: typeof draft.maskEditorImageId === 'string' ? draft.maskEditorImageId : null,
    updatedAt,
  }
}

function normalizeAgentInputDrafts(value: unknown, conversations: AgentConversation[]): Record<string, AgentInputDraft> {
  if (!isRecord(value)) return {}
  const conversationIds = new Set(conversations.map((conversation) => conversation.id))
  const drafts: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(value)) {
    if (!conversationIds.has(conversationId)) continue
    const normalized = normalizeAgentInputDraft(draft)
    if (!isEmptyAgentInputDraft(normalized)) drafts[conversationId] = normalized
  }
  return drafts
}

function normalizeAgentInputDraftsByKey(value: unknown): Record<string, AgentInputDraft> {
  if (!isRecord(value)) return {}
  const drafts: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(value)) {
    const normalized = normalizeAgentInputDraft(draft)
    if (!isEmptyAgentInputDraft(normalized)) drafts[conversationId] = normalized
  }
  return drafts
}

export function cleanStaleAgentInputDrafts(drafts: Record<string, AgentInputDraft>, activeConversationId: string | null, now = Date.now()) {
  const cutoff = now - AGENT_INPUT_DRAFT_RETENTION_MS
  const next: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(drafts)) {
    if (conversationId === activeConversationId || (draft.updatedAt ?? now) >= cutoff) {
      next[conversationId] = draft
    }
  }
  return next
}

function clearInputDraftState(): Pick<AgentInputDraft, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'> {
  return {
    prompt: '',
    inputImages: [],
    maskDraft: null,
    maskEditorImageId: null,
  }
}

function copyAgentInputDraft(draft: AgentInputDraft): AgentInputDraft {
  return {
    prompt: draft.prompt,
    inputImages: draft.inputImages.map((img) => ({ ...img })),
    maskDraft: draft.maskDraft ? { ...draft.maskDraft } : null,
    maskEditorImageId: draft.maskEditorImageId,
    updatedAt: draft.updatedAt ?? Date.now(),
  }
}

function getCurrentAgentInputDraft(state: Pick<AppState, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'>): AgentInputDraft {
  return {
    prompt: state.prompt,
    inputImages: state.inputImages,
    maskDraft: state.maskDraft,
    maskEditorImageId: state.maskEditorImageId,
    updatedAt: Date.now(),
  }
}

function splitBatchPromptDraft(prompt: string): string[] {
  const parts = prompt
    .split(/\n\s*---+\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : [prompt.trim()].filter(Boolean)
}

function isEmptyAgentInputDraft(draft: AgentInputDraft) {
  return draft.prompt.length === 0 && draft.inputImages.length === 0 && !draft.maskDraft && !draft.maskEditorImageId
}

function setAgentInputDraft(drafts: Record<string, AgentInputDraft>, conversationId: string, draft: AgentInputDraft) {
  const next = { ...drafts }
  if (isEmptyAgentInputDraft(draft)) {
    delete next[conversationId]
  } else {
    next[conversationId] = copyAgentInputDraft(draft)
  }
  return next
}

function saveActiveAgentInputDrafts(state: Pick<AppState, 'appMode' | 'activeAgentConversationId' | 'agentInputDrafts' | 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'>) {
  if (state.appMode !== 'agent' || !state.activeAgentConversationId) return state.agentInputDrafts
  return setAgentInputDraft(state.agentInputDrafts, state.activeAgentConversationId, getCurrentAgentInputDraft(state))
}

function saveGalleryInputDraft(state: Pick<AppState, 'appMode' | 'galleryInputDraft' | 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'>) {
  if (state.appMode !== 'gallery' && state.appMode !== 'video') return state.galleryInputDraft
  const draft = getCurrentAgentInputDraft(state)
  return isEmptyAgentInputDraft(draft) ? null : copyAgentInputDraft(draft)
}

function getPersistableGalleryInputDraft(state: AppState) {
  return saveGalleryInputDraft(state)
}

function restoreGalleryInputDraftState(draft: AgentInputDraft | null): Pick<AgentInputDraft, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'> {
  if (!draft) return clearInputDraftState()
  return {
    prompt: draft.prompt,
    inputImages: draft.inputImages.map((img) => ({ ...img })),
    maskDraft: draft.maskDraft ? { ...draft.maskDraft } : null,
    maskEditorImageId: draft.maskEditorImageId,
  }
}

function restoreAgentInputDraftState(drafts: Record<string, AgentInputDraft>, conversationId: string | null): Pick<AgentInputDraft, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'> {
  const draft = conversationId ? drafts[conversationId] : null
  return restoreGalleryInputDraftState(draft ?? null)
}

function syncActiveInputDraft<T extends Partial<AgentInputDraft>>(
  state: AppState,
  patch: T,
): T & { agentInputDrafts?: Record<string, AgentInputDraft>; galleryInputDraft?: AgentInputDraft | null } {
  const draft: AgentInputDraft = {
    prompt: patch.prompt ?? state.prompt,
    inputImages: patch.inputImages ?? state.inputImages,
    maskDraft: patch.maskDraft !== undefined ? patch.maskDraft : state.maskDraft,
    maskEditorImageId: patch.maskEditorImageId !== undefined ? patch.maskEditorImageId : state.maskEditorImageId,
  }
  if (state.appMode === 'gallery' || state.appMode === 'video') {
    return {
      ...patch,
      galleryInputDraft: isEmptyAgentInputDraft(draft) ? null : copyAgentInputDraft(draft),
    }
  }
  if (!state.activeAgentConversationId) return patch
  return {
    ...patch,
    agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, state.activeAgentConversationId, draft),
  }
}

function getPersistableAgentInputDrafts(state: AppState) {
  const drafts = saveActiveAgentInputDrafts(state)
  const conversationIds = new Set(state.agentConversations.map((conversation) => conversation.id))
  const persistable: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(drafts)) {
    if (!conversationIds.has(conversationId) || isEmptyAgentInputDraft(draft)) continue
    persistable[conversationId] = {
      ...copyAgentInputDraft(draft),
      inputImages: draft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })),
    }
  }
  return persistable
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Mode
      appMode: 'gallery',
      setAppMode: (appMode) => {
        if (appMode === 'gallery' || appMode === 'video' || appMode === 'workflow') {
          const state = get()
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          const galleryInputDraft = saveGalleryInputDraft(state)
          set((state) => ({
            appMode,
            agentInputDrafts,
            galleryInputDraft,
            agentMobileHeaderVisible: true,
            selectedTaskIds: [],
            agentEditingRoundId: null,
            ...(state.appMode === 'agent' ? restoreGalleryInputDraftState(galleryInputDraft) : {}),
          }))
          return
        }

        // Agent 模式经 env 配置的上游代理（cliproxyapi）调用 Responses API，无需用户手动配置接口模式，直接进入。
        const state = get()
        const galleryInputDraft = saveGalleryInputDraft(state)
        set((state) => ({
          appMode: 'agent',
          galleryInputDraft,
          agentMobileHeaderVisible: false,
          agentSidebarCollapsed: true,
          agentAssetPanelCollapsed: true,
          selectedTaskIds: [],
          ...restoreAgentInputDraftState(state.agentInputDrafts, state.activeAgentConversationId),
        }))
      },

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const settings = normalizeSettings(merged)
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
            : {}),
        }
      }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      replaceInputImage: (idx, img) => {
        let removedImageId: string | null = null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removedImageId = previous.id
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          const shouldClearMask = previous.id === s.maskDraft?.targetImageId
          return syncActiveInputDraft(s, {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages, { [previous.id]: img.id }),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          })
        })
        if (removedImageId) void deleteImageIfUnreferenced(removedImageId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return syncActiveInputDraft(s, {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          })
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) evictCachedImage(img.id)
          return syncActiveInputDraft(s, {
            inputImages: [],
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          const shouldClearMask =
            Boolean(s.maskDraft) && !inputImages.some((img) => img.id === s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages, options?.equivalentImageIds),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          })
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, {
            inputImages: images,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, images),
          })
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        }),
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
      }),

      // Agent
      agentConversations: [],
      agentConversationsLoaded: false,
      activeAgentConversationId: null,
      agentInputDrafts: {},
      agentSidebarCollapsed: true,
      agentAssetTab: 'outputs',
      agentAssetPanelCollapsed: false,
      agentMobileHeaderVisible: false,
      agentEditingRoundId: null,
      agentEditingConversationId: null,
      agentGeneratingTitleIds: {},
      createAgentConversation: () => {
        const now = Date.now()
        const latestConversation = getLatestAgentConversation(get().agentConversations)
        if (latestConversation && isEmptyAgentConversation(latestConversation)) {
          set((state) => {
            const agentInputDrafts = saveActiveAgentInputDrafts(state)
            return {
              agentConversations: state.agentConversations.map((conversation) =>
                conversation.id === latestConversation.id
                  ? { ...conversation, createdAt: now, updatedAt: now }
                  : conversation,
              ),
              activeAgentConversationId: latestConversation.id,
              agentInputDrafts,
              agentSidebarCollapsed: true,
              agentEditingRoundId: null,
              ...restoreAgentInputDraftState(agentInputDrafts, latestConversation.id),
            }
          })
          return latestConversation.id
        }

        const conversation = createAgentConversation(now)
        set((state) => {
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          return {
            agentConversations: [
              ...state.agentConversations,
              conversation,
            ],
            activeAgentConversationId: conversation.id,
            agentInputDrafts,
            agentSidebarCollapsed: true,
            agentEditingRoundId: null,
            ...restoreAgentInputDraftState(agentInputDrafts, conversation.id),
          }
        })
        return conversation.id
      },
      setActiveAgentConversationId: (id) => set((state) => {
        if (state.activeAgentConversationId === id) {
          return {
            activeAgentConversationId: id,
            agentSidebarCollapsed: true,
            agentAssetPanelCollapsed: true,
            agentEditingRoundId: null,
          }
        }
        const agentInputDrafts = saveActiveAgentInputDrafts(state)
        return {
          activeAgentConversationId: id,
          agentInputDrafts,
          agentSidebarCollapsed: true,
          agentAssetPanelCollapsed: true,
          agentEditingRoundId: null,
          ...restoreAgentInputDraftState(agentInputDrafts, id),
        }
      }),
      setActiveAgentRoundId: (conversationId, roundId) => set((state) => ({
        agentConversations: state.agentConversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, activeRoundId: roundId, updatedAt: Date.now() } : conversation,
        ),
      })),
      renameAgentConversation: (id, title) => set((state) => ({ agentConversations: state.agentConversations.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)) })),
      deleteAgentConversation: (id) => set((state) => {
        const agentInputDrafts = { ...state.agentInputDrafts }
        delete agentInputDrafts[id]
        const activeDeleted = state.activeAgentConversationId === id
        return {
          agentConversations: state.agentConversations.filter((c) => c.id !== id),
          activeAgentConversationId: activeDeleted ? null : state.activeAgentConversationId,
          agentInputDrafts,
          ...(activeDeleted ? clearInputDraftState() : {}),
        }
      }),
      setAgentSidebarCollapsed: (agentSidebarCollapsed) => set({ agentSidebarCollapsed }),
      setAgentAssetTab: (agentAssetTab) => set({ agentAssetTab }),
      setAgentAssetPanelCollapsed: (agentAssetPanelCollapsed) => set({ agentAssetPanelCollapsed }),
      setAgentMobileHeaderVisible: (agentMobileHeaderVisible) => set({ agentMobileHeaderVisible }),
      setAgentEditingRoundId: (agentEditingRoundId) => set({ agentEditingRoundId }),
      setAgentEditingConversationId: (agentEditingConversationId) => set({ agentEditingConversationId }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set({ tasks }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),
      regeneratingImageSlots: {},
      regeneratingImageSlotLabels: {},
      setRegeneratingImageSlot: (taskId, imageIndex, label) => set((s) => {
        const { [taskId]: _removed, ...rest } = s.regeneratingImageSlots
        const { [taskId]: _removedLabel, ...restLabels } = s.regeneratingImageSlotLabels
        return {
          regeneratingImageSlots: imageIndex == null
            ? rest
            : { ...rest, [taskId]: imageIndex },
          regeneratingImageSlotLabels: imageIndex == null
            ? restLabels
            : label
            ? { ...restLabels, [taskId]: label }
            : restLabels,
        }
      }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      showLogPanel: false,
      setShowLogPanel: (showLogPanel) => {
        if (showLogPanel) dismissAllTooltips()
        set({ showLogPanel })
      },

      // Queue stats
      queueStats: null,
      setQueueStats: (queueStats) => set({ queueStats }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Prompt
      promptDialog: null,
      setPromptDialog: (promptDialog) => {
        if (promptDialog) dismissAllTooltips()
        set({ promptDialog })
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: namespacedStorageKey('picpilot'),
      version: 2,
      migrate: (persistedState) => migratePersistedState(persistedState),
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

let lastStoredAgentConversations = useStore.getState().agentConversations
let agentConversationPersistRunning = false
let agentConversationPersistQueued = false

async function flushAgentConversationsToIndexedDB() {
  if (agentConversationPersistRunning) {
    agentConversationPersistQueued = true
    return
  }

  agentConversationPersistRunning = true
  try {
    do {
      agentConversationPersistQueued = false
      const conversations = useStore.getState().agentConversations
      await replaceStoredAgentConversations(conversations)
      lastStoredAgentConversations = conversations
    } while (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations)
  } finally {
    agentConversationPersistRunning = false
  }
}

useStore.subscribe((state) => {
  if (state.agentConversations === lastStoredAgentConversations) return
  if (!agentConversationPersistenceReady) {
    agentConversationPersistQueued = true
    return
  }
  void flushAgentConversationsToIndexedDB()
})

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

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

function clearOpenAIWatchdogTimer(taskId: string) {
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

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
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

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const provider = task.apiProvider
  if (!provider || provider === 'openai') return null
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === provider) return taskProfile
  return null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const provider = task.apiProvider

  if (!task.apiProfileId) return null

  const byId = normalized.profiles.find((profile) => profile.id === task.apiProfileId)
  if (byId && (!provider || byId.provider === provider)) return byId
  return null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

function getProfileUpstreamMode(profile: ApiProfile): UpstreamMode | undefined {
  return profile.provider === 'openai' ? profile.upstreamMode : undefined
}

function sourceFromProfile(profile: ApiProfile): TaskImageSource {
  return {
    apiProvider: profile.provider,
    apiProfileId: profile.id,
    apiProfileName: profile.name,
    apiMode: profile.apiMode,
    apiModel: profile.model,
    upstreamMode: getProfileUpstreamMode(profile),
  }
}

function taskSourcePatchFromProfile(profile: ApiProfile): Partial<TaskRecord> {
  return {
    apiProvider: profile.provider,
    apiProfileId: profile.id,
    apiProfileName: profile.name,
    apiMode: profile.apiMode,
    apiModel: profile.model,
    upstreamMode: getProfileUpstreamMode(profile),
  }
}

function getFailedImageRetryProfile(settings: AppSettings, task: TaskRecord): ApiProfile {
  const activeProfile = getActiveApiProfile(settings)
  if (!task.apiProvider || activeProfile.provider === task.apiProvider) return activeProfile
  return getTaskApiProfile(settings, task) ?? activeProfile
}

function imageSourcesFor(ids: string[], source: TaskImageSource): Record<string, TaskImageSource> | undefined {
  const entries = ids.map((id) => [id, source] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function mergeImageSources(
  current: Record<string, TaskImageSource> | undefined,
  ids: string[],
  source: TaskImageSource,
): Record<string, TaskImageSource> | undefined {
  const next = { ...(current ?? {}) }
  for (const id of ids) next[id] = source
  return Object.keys(next).length ? next : undefined
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function shouldRetryWithoutImageStreaming(err: unknown, profile: ApiProfile, signal?: AbortSignal): boolean {
  if (!isTeamStreamFallbackEnabled()) return false
  if (profile.provider !== 'openai' || profile.streamImages !== true) return false
  if (signal?.aborted) return false
  if (isApiTimeoutError(err)) return false

  if (err instanceof TypeError) return true
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true

  const message = err instanceof Error ? err.message : String(err)
  return /empty_stream|upstream stream closed before first payload|stream disconnected before completion|stream closed before response\.completed|流式接口未返回最终图片数据|流式接口未返回可用图片数据|internal_server_error|server_error|\bHTTP (408|5\d\d)\b/i.test(message)
}

function createSettingsWithoutImageStreaming(settings: AppSettings, profile: ApiProfile): AppSettings {
  return createSettingsForApiProfile(settings, {
    ...profile,
    streamImages: false,
    streamPartialImages: 0,
  })
}

interface ImageStreamFallbackContext {
  profile: ApiProfile
  appMode: AppMode
  taskId?: string
  notify?: () => void
  detail?: Record<string, unknown>
}

async function callImageApiWithStreamFallback(opts: CallApiOptions, context: ImageStreamFallbackContext): Promise<CallApiResult> {
  try {
    return await callImageApi(opts)
  } catch (err) {
    if (!shouldRetryWithoutImageStreaming(err, context.profile, opts.signal)) throw err

    logger.warn('task', '图像流式响应异常，关闭流式后自动重试', {
      appMode: context.appMode,
      taskId: context.taskId,
      provider: context.profile.provider,
      profileName: context.profile.name,
      model: context.profile.model,
      ...context.detail,
      error: serializeError(err),
    })
    context.notify?.()
    return callImageApi({
      ...opts,
      settings: createSettingsWithoutImageStreaming(opts.settings, context.profile),
    })
  }
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore() {
  const legacyAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  const storedTasks = await getAllTasks()
  const storedAgentConversations = normalizeAgentConversations(await getAllAgentConversations())
  let loadedAgentConversations = mergeAgentConversationsForStorage(storedAgentConversations, legacyAgentConversations)
  const currentAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  loadedAgentConversations = mergeAgentConversationsForStorage(loadedAgentConversations, currentAgentConversations)
  const activeAgentConversationId = useStore.getState().activeAgentConversationId && loadedAgentConversations.some((conversation) => conversation.id === useStore.getState().activeAgentConversationId)
    ? useStore.getState().activeAgentConversationId
    : loadedAgentConversations[0]?.id ?? null
  if (loadedAgentConversations.length > 0 || legacyAgentConversations.length > 0) {
    useStore.setState((state) => {
      const agentInputDrafts = cleanStaleAgentInputDrafts(
        normalizeAgentInputDrafts(state.agentInputDrafts, loadedAgentConversations),
        activeAgentConversationId,
      )
      return {
        agentConversations: loadedAgentConversations,
        agentConversationsLoaded: true,
        activeAgentConversationId,
        agentInputDrafts,
        ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, activeAgentConversationId) : {}),
      }
    })
    await replaceStoredAgentConversations(loadedAgentConversations)
  } else {
    useStore.setState({ agentConversationsLoaded: true })
  }
  const shouldRewritePersistedLocalState = agentConversationMigrationPending
  agentConversationPersistenceReady = true
  agentConversationMigrationPending = false
  if (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations) {
    await flushAgentConversationsToIndexedDB()
  }
  if (shouldRewritePersistedLocalState) {
    useStore.setState({})
  }
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks)
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const tasks = markedTasks.map(getPersistableTask)
  await Promise.all(tasks
    .filter((task, index) => interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  for (const task of tasks) {
    if (
      task.customTaskId &&
      (task.status === 'running' || task.customRecoverable)
    ) {
      scheduleCustomRecovery(task.id, 0)
    }
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft
  const agentConversations = state.agentConversations
  const agentInputDrafts = state.agentInputDrafts
  for (const img of persistedInputImages) referencedIds.add(img.id)
  if (galleryInputDraft) {
    for (const img of galleryInputDraft.inputImages) referencedIds.add(img.id)
  }
  for (const draft of Object.values(agentInputDrafts)) {
    for (const img of draft.inputImages) referencedIds.add(img.id)
  }
  for (const conversation of agentConversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) referencedIds.add(id)
    }
  }
  for (const t of tasks) {
    addTaskReferencedImageIds(referencedIds, t)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
    } else {
      await deleteImage(imgId)
    }
  }
  scheduleThumbnailBackfill(referencedImageIds)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }

  if (galleryInputDraft) {
    const restoredGalleryImages: InputImage[] = []
    for (const img of galleryInputDraft.inputImages) {
      if (img.dataUrl) {
        restoredGalleryImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredGalleryImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }
    const shouldClearMask = Boolean(galleryInputDraft.maskDraft) && !restoredGalleryImages.some((img) => img.id === galleryInputDraft.maskDraft?.targetImageId)
    const restoredGalleryDraft: AgentInputDraft = {
      ...galleryInputDraft,
      inputImages: restoredGalleryImages,
      prompt: remapImageMentionsForOrder(galleryInputDraft.prompt, galleryInputDraft.inputImages, restoredGalleryImages),
      ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
    }
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const latestState = useStore.getState()
      const nextGalleryInputDraft = isEmptyAgentInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...(latestState.appMode === 'gallery'
          ? restoreGalleryInputDraftState(nextGalleryInputDraft)
          : {}),
      })
    }
  }

  const restoredAgentInputDrafts: Record<string, AgentInputDraft> = {}
  let agentDraftsChanged = false
  for (const [conversationId, draft] of Object.entries(agentInputDrafts)) {
    const restoredDraftImages: InputImage[] = []
    for (const img of draft.inputImages) {
      if (img.dataUrl) {
        restoredDraftImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredDraftImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }

    const shouldClearMask = Boolean(draft.maskDraft) && !restoredDraftImages.some((img) => img.id === draft.maskDraft?.targetImageId)
    const restoredDraft: AgentInputDraft = {
      ...draft,
      inputImages: restoredDraftImages,
      prompt: remapImageMentionsForOrder(draft.prompt, draft.inputImages, restoredDraftImages),
      ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
    }
    if (!isEmptyAgentInputDraft(restoredDraft)) restoredAgentInputDrafts[conversationId] = restoredDraft
    if (
      restoredDraftImages.length !== draft.inputImages.length ||
      restoredDraftImages.some((img, index) => img.dataUrl !== draft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    ) {
      agentDraftsChanged = true
    }
  }
  if (agentDraftsChanged) {
    const latestState = useStore.getState()
    useStore.setState({
      agentInputDrafts: restoredAgentInputDrafts,
      ...(latestState.appMode === 'agent'
        ? restoreAgentInputDraftState(restoredAgentInputDrafts, latestState.activeAgentConversationId)
        : {}),
    })
  }
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

function addAgentReferencedImageIds(target: Set<string>, conversations = useStore.getState().agentConversations, inputDrafts = useStore.getState().agentInputDrafts) {
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

function addInputDraftReferencedImageIds(target: Set<string>, draft: AgentInputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) target.add(img.id)
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

function addTaskReferencedVideoIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.outputVideos || []) target.add(id)
}

function replaceImageKeyedValue<T>(
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

function replaceRawImageUrl(
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

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
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

async function deleteUnreferencedVideoIds(videoIds: Iterable<string>) {
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

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  try {
    const imgId = await storeImage(dataUrl, 'generated')
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
const taskAbortControllers = new Map<string, AbortController>()

async function resolveImageApiFanoutConcurrency(): Promise<number> {
  const fallbackMaxConcurrent = getCachedAuthUser()?.maxConcurrent
  try {
    const stats = await fetchQueueStats()
    useStore.getState().setQueueStats(stats)
    return getImageApiFanoutConcurrency(stats)
  } catch {
    return getImageApiFanoutConcurrency({ maxConcurrent: fallbackMaxConcurrent })
  }
}

function getGalleryAutoRetryCount(): number {
  const count = getCachedAuthUser()?.galleryAutoRetryCount ?? 1
  return Number.isFinite(count) ? Math.max(0, Math.min(5, Math.trunc(count))) : 1
}

type TaskAppModeSource = Pick<
  TaskRecord,
  'mediaType' | 'sourceMode' | 'agentConversationId' | 'agentRoundId' | 'agentMessageId' | 'agentToolCallId'
>

function getTaskAppMode(task: TaskAppModeSource): AppMode {
  if (task.mediaType === 'video' || task.sourceMode === 'video') return 'video'
  if (task.sourceMode === 'agent' || task.agentConversationId || task.agentRoundId || task.agentMessageId || task.agentToolCallId) return 'agent'
  return 'gallery'
}

// 多图「每张」合并卡的执行：按每张输入图各发一次请求，汇总成一个 CallApiResult。
// 输出顺序 = 输入图顺序；图片/实际参数/改写提示词按输出顺序对齐；任一输入失败计入 failedCount（每输入占 perInputCount 张）。
// 流式预览槽位按 inputIndex * perInputCount 偏移，避免不同输入的中间帧互相覆盖。
async function callImageApiPerInput(
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
      const opts: CallApiOptions = {
        ...baseOpts,
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
  return {
    images,
    actualParams: fulfilled[0]?.actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(failedCount ? { failedCount, failedErrors } : {}),
  }
}

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

async function executeVideoTask(taskId: string) {
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

async function executeTask(taskId: string) {
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
    useStore.getState().setTaskStreamPreview(taskId)
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

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
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

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const actualParamsList = await readImageSizeParamsList(result.images)
  const outputIds: string[] = []
  for (const dataUrl of result.images) {
    const imgId = await storeImage(dataUrl, 'generated')
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

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const tasks = options.exportTasks ? await getAllTasks() : []
    const images = options.exportTasks ? await getAllImages() : []
    const videos = options.exportTasks ? await getAllVideos() : []
    const { settings, agentConversations } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()
    const videoCreatedAtFallback = new Map<string, number>()

    if (options.exportTasks) {
      for (const task of tasks) {
        for (const id of [
          ...(task.inputImageIds || []),
          ...(task.maskImageId ? [task.maskImageId] : []),
          ...(task.outputImages || []),
          ...(task.streamPartialImageIds || []),
        ]) {
          const prev = imageCreatedAtFallback.get(id)
          if (prev == null || task.createdAt < prev) {
            imageCreatedAtFallback.set(id, task.createdAt)
          }
        }
        for (const id of task.outputVideos || []) {
          const prev = videoCreatedAtFallback.get(id)
          if (prev == null || task.createdAt < prev) {
            videoCreatedAtFallback.set(id, task.createdAt)
          }
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
    const videoFiles: NonNullable<ExportData['videoFiles']> = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    if (options.exportTasks) {
      for (const img of images) {
        const { ext, bytes } = dataUrlToBytes(img.dataUrl)
        const path = `images/${img.id}.${ext}`
        const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
        imageFiles[img.id] = {
          path,
          createdAt,
          source: img.source,
          width: img.width,
          height: img.height,
        }
        zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]

        const thumbnail = await getImageThumbnail(img.id)
        if (thumbnail?.thumbnailDataUrl) {
          const { ext: thumbnailExt, bytes: thumbnailBytes } = dataUrlToBytes(thumbnail.thumbnailDataUrl)
          const thumbnailPath = `thumbnails/${img.id}.${thumbnailExt}`
          imageFiles[img.id].width = imageFiles[img.id].width ?? thumbnail.width
          imageFiles[img.id].height = imageFiles[img.id].height ?? thumbnail.height
          thumbnailFiles[img.id] = {
            path: thumbnailPath,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          }
          zipFiles[thumbnailPath] = [thumbnailBytes, { mtime: new Date(createdAt) }]
          cacheThumbnail(img.id, {
            dataUrl: thumbnail.thumbnailDataUrl,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          })
        }
      }

      for (const video of videos) {
        const createdAt = video.createdAt ?? videoCreatedAtFallback.get(video.id) ?? exportedAt
        const entry: NonNullable<ExportData['videoFiles']>[string] = {
          remoteUrl: video.remoteUrl,
          mime: video.mime,
          durationSeconds: video.durationSeconds,
          createdAt,
          source: video.source,
        }
        if (video.blob) {
          const ext = (video.mime?.split('/')[1] || 'mp4').replace(/[^a-z0-9]+/gi, '') || 'mp4'
          const path = `videos/${video.id}.${ext}`
          entry.path = path
          zipFiles[path] = [new Uint8Array(await video.blob.arrayBuffer()), { mtime: new Date(createdAt) }]
        }
        if (video.posterDataUrl) {
          const { ext, bytes } = dataUrlToBytes(video.posterDataUrl)
          const posterPath = `video-posters/${video.id}.${ext}`
          entry.posterPath = posterPath
          zipFiles[posterPath] = [bytes, { mtime: new Date(createdAt) }]
        }
        videoFiles[video.id] = entry
      }
    }

    const manifest: ExportData = {
      version: 3,
      exportedAt: new Date(exportedAt).toISOString(),
    }

    if (options.exportConfig) manifest.settings = settings
    if (options.exportTasks) {
      manifest.tasks = tasks
      manifest.agentConversations = getPersistableAgentConversations(agentConversations)
      manifest.imageFiles = imageFiles
      manifest.thumbnailFiles = thumbnailFiles
      manifest.videoFiles = videoFiles
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `picpilot-backup_${formatExportFileTime(new Date(exportedAt))}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${getUserFacingErrorMessage(e, '无法生成备份文件')}`,
        'error',
      )
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

/** 导入 ZIP 数据 */
export async function importData(file: File, options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))

    const importedImageIds: string[] = []
    if (options.importTasks && data.tasks && data.imageFiles) {
      // 还原图片
      for (const [id, info] of Object.entries(data.imageFiles)) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const dataUrl = bytesToDataUrl(bytes, info.path)
        await putImage({
          id,
          dataUrl,
          createdAt: info.createdAt,
          source: info.source,
          width: info.width,
          height: info.height,
        })
        cacheImage(id, dataUrl)
        importedImageIds.push(id)
      }

      for (const [id, info] of Object.entries(data.thumbnailFiles ?? {})) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const thumbnailDataUrl = bytesToDataUrl(bytes, info.path)
        await putImageThumbnail({
          id,
          thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
        cacheThumbnail(id, {
          dataUrl: thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
      }

      for (const [id, info] of Object.entries(data.videoFiles ?? {})) {
        const bytes = info.path ? unzipped[info.path] : undefined
        const posterBytes = info.posterPath ? unzipped[info.posterPath] : undefined
        await dbPutVideo({
          id,
          blob: bytes ? new Blob([uint8ToArrayBuffer(bytes)], { type: info.mime || 'video/mp4' }) : undefined,
          remoteUrl: info.remoteUrl,
          mime: info.mime,
          posterDataUrl: posterBytes && info.posterPath ? bytesToDataUrl(posterBytes, info.posterPath) : undefined,
          durationSeconds: info.durationSeconds,
          createdAt: info.createdAt,
          source: info.source,
        })
      }

      for (const task of data.tasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      useStore.getState().setTasks(tasks)
      const importedAgentConversations = normalizeAgentConversations(data.agentConversations)
        .filter((conversation) => !isEmptyAgentConversation(conversation))
      useStore.setState((state) => {
        const agentConversations = mergeImportedAgentConversations(state.agentConversations, importedAgentConversations)
        const activeAgentConversationId = state.activeAgentConversationId && agentConversations.some((conversation) => conversation.id === state.activeAgentConversationId)
          ? state.activeAgentConversationId
          : importedAgentConversations[0]?.id ?? agentConversations[0]?.id ?? null
        return {
          agentConversations,
          activeAgentConversationId,
        }
      })
      await replaceStoredAgentConversations(useStore.getState().agentConversations)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && data.settings) {
      const state = useStore.getState()
      state.setSettings(mergeImportedSettings(state.settings, data.settings))
    }

    let msg = '数据已成功导入'
    if (options.importTasks && data.tasks) {
      msg = `已导入 ${data.tasks.length} 条记录`
    } else if (options.importConfig && data.settings) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${getUserFacingErrorMessage(e, '备份文件无法读取')}`,
        'error',
      )
    return false
  }
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

bindAgentOrchestrator({
  getState: () => useStore.getState(),
  setState: (partial) => { useStore.setState(partial as never) },
  updateTaskInStore,
  genId,
  putTask,
  createSettingsForApiProfile,
  persistTaskStreamPartialImage,
})
