import type { ApiProfile, AppMode, AppSettings, TaskImageSource, TaskRecord, UpstreamMode } from '../types'
import { getActiveApiProfile, normalizeSettings } from '../lib/apiProfiles'
import { callImageApi, type CallApiOptions, type CallApiResult } from '../lib/api'
import { logger, serializeError } from '../lib/logger'
import { isApiTimeoutError } from '../lib/imageApiShared'
import { isTeamStreamFallbackEnabled } from '../lib/runtimeTeamSettings'
import { useStore } from './coreStore'

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
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

export function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
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

export function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
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

export function sourceFromProfile(profile: ApiProfile): TaskImageSource {
  return {
    apiProvider: profile.provider,
    apiProfileId: profile.id,
    apiProfileName: profile.name,
    apiMode: profile.apiMode,
    apiModel: profile.model,
    upstreamMode: getProfileUpstreamMode(profile),
  }
}

export function taskSourcePatchFromProfile(profile: ApiProfile): Partial<TaskRecord> {
  return {
    apiProvider: profile.provider,
    apiProfileId: profile.id,
    apiProfileName: profile.name,
    apiMode: profile.apiMode,
    apiModel: profile.model,
    upstreamMode: getProfileUpstreamMode(profile),
  }
}

export function getFailedImageRetryProfile(settings: AppSettings, task: TaskRecord): ApiProfile {
  const activeProfile = getActiveApiProfile(settings)
  if (!task.apiProvider || activeProfile.provider === task.apiProvider) return activeProfile
  return getTaskApiProfile(settings, task) ?? activeProfile
}

export function imageSourcesFor(ids: string[], source: TaskImageSource): Record<string, TaskImageSource> | undefined {
  const entries = ids.map((id) => [id, source] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function mergeImageSources(
  current: Record<string, TaskImageSource> | undefined,
  ids: string[],
  source: TaskImageSource,
): Record<string, TaskImageSource> | undefined {
  const next = { ...(current ?? {}) }
  for (const id of ids) next[id] = source
  return Object.keys(next).length ? next : undefined
}

export function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

export function getTaskApiProfileName(task: TaskRecord) {
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

export interface ImageStreamFallbackContext {
  profile: ApiProfile
  appMode: AppMode
  taskId?: string
  notify?: () => void
  detail?: Record<string, unknown>
}

export async function callImageApiWithStreamFallback(opts: CallApiOptions, context: ImageStreamFallbackContext): Promise<CallApiResult> {
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

export function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}
