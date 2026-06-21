import type { AgentConversation } from '../types'
import { normalizeSettings } from '../lib/shared/apiProfiles'
import {
  getPersistableAgentConversation,
  getPersistableAgentConversations,
  normalizeAgentConversations,
} from '../lib/agent/agentPersistence'
import { replaceAgentConversations } from '../lib/shared/db'
import type { AppState } from './appState'
import {
  cleanStaleAgentInputDrafts,
  getPersistableAgentInputDrafts,
  getPersistableGalleryInputDraft,
  isEmptyAgentInputDraft,
  normalizeAgentInputDraft,
  normalizeAgentInputDrafts,
  normalizeAgentInputDraftsByKey,
} from './inputDrafts'

let agentConversationPersistenceReady = false
let agentConversationMigrationPending = false

// 跨模块共享的持久化标记访问器（拆分自 store.ts，行为不变）
export function isAgentConversationPersistenceReady() {
  return agentConversationPersistenceReady
}

export function setAgentConversationPersistenceReady(ready: boolean) {
  agentConversationPersistenceReady = ready
}

export function isAgentConversationMigrationPending() {
  return agentConversationMigrationPending
}

export function setAgentConversationMigrationPending(pending: boolean) {
  agentConversationMigrationPending = pending
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
    activeCanvasId: state.activeCanvasId,
    agentInputDrafts: getPersistableAgentInputDrafts(state),
    agentSidebarCollapsed: state.agentSidebarCollapsed,
    agentAssetTab: state.agentAssetTab,
    agentAssetPanelCollapsed: state.agentAssetPanelCollapsed,
  }
}

export async function replaceStoredAgentConversations(conversations: AgentConversation[]) {
  await replaceAgentConversations(conversations.map(getPersistableAgentConversation))
}

export function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
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
  const appMode = persisted.appMode === 'agent' || persisted.appMode === 'video' || persisted.appMode === 'workflow' || persisted.appMode === 'canvas' ? persisted.appMode : 'gallery'
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
