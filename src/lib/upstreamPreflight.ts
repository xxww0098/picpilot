import type { ApiProfile, AppSettings } from '../types'
import { authJson } from './apiClient'

export async function preflightImageUpstream(_settings: AppSettings, profile: ApiProfile, signal?: AbortSignal): Promise<void> {
  if (profile.provider !== 'openai' || profile.upstreamMode !== 'api') return

  const params = new URLSearchParams({
    mode: 'api',
    model: profile.model,
    apiMode: profile.apiMode,
  })
  await authJson<{ ok: true }>(`/api/upstream/preflight?${params.toString()}`, { signal }, '上游预检失败')
}
