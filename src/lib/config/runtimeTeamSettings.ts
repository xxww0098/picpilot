import type { AppSettings } from '../../types'
import { normalizeSettings } from '../shared/apiProfiles'
import { getCachedAuthUser } from '../shared/auth'

export function applyTeamRuntimeSettings(settings: AppSettings): AppSettings {
  const user = getCachedAuthUser()
  const timeout = Number(user?.requestTimeoutSeconds)
  if (!Number.isFinite(timeout) || timeout <= 0) return settings

  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    timeout,
    profiles: normalized.profiles.map((profile) => ({ ...profile, timeout })),
  })
}

export function isTeamStreamFallbackEnabled(): boolean {
  return getCachedAuthUser()?.streamFallbackEnabled !== false
}
