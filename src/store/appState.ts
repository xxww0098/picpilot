import type {
  AgentConversation,
  AgentAssetStatus,
  AgentPlatformId,
  AppSettings,
  AppMode,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
} from '../types'
import type { QueueStats } from '../lib/server/queueApi'

export type ToastType = 'info' | 'success' | 'error'
export type AgentInputDraft = {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  agentTargetAssetSlotId?: string | null
  updatedAt?: number
}

export type SettingsTab = 'general' | 'agent' | 'api' | 'data' | 'about'

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
  agentTargetAssetSlotId: string | null
  agentGeneratingTitleIds: Record<string, true>
  createAgentConversation: (platformId?: AgentPlatformId) => string
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
  setAgentTargetAssetSlotId: (slotId: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  setAgentTaskAssetStatus: (taskId: string, status: AgentAssetStatus) => void
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
