import type { TaskRecord } from './types'
import { putTask } from './lib/agent/taskPersistence'
import { bindAgentOrchestrator } from './lib/agent/agentOrchestrator'
import type { AppState } from './store/appState'
import { genId, useStore } from './store/coreStore'
import { createSettingsForApiProfile } from './store/taskProfiles'
import { persistTaskStreamPartialImage, updateTaskInStore } from './store/taskRuntime'

export { getErrorToastMessage } from './lib/ui/errorToast'
export { migratePersistedState } from './lib/agent/agentPersistence'
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
} from './lib/agent/agentOrchestrator'
export {
  ensureImageCached,
  ensureImageThumbnailCached,
  getCachedImage,
  subscribeImageThumbnail,
} from './store/imageCache'
export type { AppState, SettingsTab } from './store/appState'
export { cleanStaleAgentInputDrafts } from './store/inputDrafts'
export { getPersistedState } from './store/persistence'
export { deleteImageIfUnreferenced, useStore } from './store/coreStore'
export {
  getCodexCliPromptKey,
  getTaskApiProfile,
  showCodexCliPrompt,
} from './store/taskProfiles'
export { markInterruptedOpenAIRunningTasks, updateTaskInStore } from './store/taskRuntime'
export {
  cancelTask,
  retryFailedImages,
  retryTask,
  retryTaskInPlace,
} from './store/taskExecution'
export { submitTask, submitVideoTask } from './store/taskSubmit'
export { initStore } from './store/init'
export {
  addImageFromFile,
  addImageFromUrl,
  clearData,
  createInputImageFromFile,
  editOutputs,
  regenerateTaskImage,
  removeMultipleTasks,
  removeTask,
  reuseConfig,
  sendTaskOutputsToGallery,
} from './store/taskActions'
export type { ClearOptions } from './store/taskActions'
export { exportData, importData } from './store/backup'
export type { ExportOptions, ImportOptions } from './store/backup'

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

bindAgentOrchestrator({
  getState: () => useStore.getState(),
  setState: (partial) => { useStore.setState(partial as never) },
  updateTaskInStore,
  genId,
  putTask,
  createSettingsForApiProfile,
  persistTaskStreamPartialImage,
})
