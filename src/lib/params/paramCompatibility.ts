import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../../types'
import { getActiveApiProfile } from '../shared/apiProfiles'
import { getCachedAuthUser } from '../shared/auth'
import { normalizeAllowedOutputFormats, resolveAllowedOutputFormat } from './outputFormats'
import { normalizeImageSize } from './size'

export const MAX_OPENAI_OUTPUT_IMAGES = 10

function normalizeMaxOutputImages(limit?: number): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null
  return Math.max(1, Math.trunc(limit))
}

export function getOutputImageLimitForSettings(_settings: AppSettings, maxOutputImages?: number) {
  const userLimit = normalizeMaxOutputImages(maxOutputImages)
  return userLimit == null ? MAX_OPENAI_OUTPUT_IMAGES : Math.min(MAX_OPENAI_OUTPUT_IMAGES, userLimit)
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean; maxOutputImages?: number; allowedOutputFormats?: readonly string[] } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings, options.maxOutputImages)
  const allowedOutputFormats = normalizeAllowedOutputFormats(options.allowedOutputFormats ?? getCachedAuthUser()?.allowedOutputFormats)
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    output_format: resolveAllowedOutputFormat(params.output_format, allowedOutputFormats),
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (activeProfile.provider === 'openai' && activeProfile.codexCli) {
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
