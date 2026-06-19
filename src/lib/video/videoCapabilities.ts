// Grok Imagine 视频生成参数（对齐 xAI Python SDK / REST 兼容层）。
// 参考：https://github.com/xai-org/xai-sdk-python — types/video.py、client.video.generate()

export const VIDEO_ASPECT_RATIO_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '16:9 横屏', value: '16:9' },
  { label: '9:16 竖屏', value: '9:16' },
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
] as const

export const VIDEO_RESOLUTION_OPTIONS = [
  { label: '720p', value: '720p' },
  { label: '480p', value: '480p' },
] as const

/** 文档示例常见时长；保留 15 秒以兼容既有设置 */
export const VIDEO_DURATION_OPTIONS = [5, 6, 10, 15] as const

export type VideoAspectRatioSetting = (typeof VIDEO_ASPECT_RATIO_OPTIONS)[number]['value']
export type VideoResolutionSetting = (typeof VIDEO_RESOLUTION_OPTIONS)[number]['value']

const ALLOWED_ASPECT_RATIOS = new Set(
  VIDEO_ASPECT_RATIO_OPTIONS.map((item) => item.value),
)

const ALLOWED_RESOLUTIONS = new Set(
  VIDEO_RESOLUTION_OPTIONS.map((item) => item.value),
)

export const DEFAULT_VIDEO_ASPECT_RATIO: VideoAspectRatioSetting = '16:9'
export const DEFAULT_VIDEO_RESOLUTION: VideoResolutionSetting = '720p'

export function normalizeVideoAspectRatio(
  value: unknown,
  fallback: VideoAspectRatioSetting = DEFAULT_VIDEO_ASPECT_RATIO,
): VideoAspectRatioSetting {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw && ALLOWED_ASPECT_RATIOS.has(raw as VideoAspectRatioSetting)) {
    return raw as VideoAspectRatioSetting
  }
  return fallback
}

export function normalizeVideoResolution(
  value: unknown,
  fallback: VideoResolutionSetting = DEFAULT_VIDEO_RESOLUTION,
): VideoResolutionSetting {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw && ALLOWED_RESOLUTIONS.has(raw as VideoResolutionSetting)) {
    return raw as VideoResolutionSetting
  }
  return fallback
}

export function normalizeVideoDurationChoice(
  value: unknown,
  fallback: number,
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const snapped = Math.trunc(numeric)
  if ((VIDEO_DURATION_OPTIONS as readonly number[]).includes(snapped)) return snapped
  let best: number = VIDEO_DURATION_OPTIONS[0]
  let bestDist = Math.abs(snapped - best)
  for (const option of VIDEO_DURATION_OPTIONS) {
    const dist = Math.abs(snapped - option)
    if (dist < bestDist) {
      best = option
      bestDist = dist
    }
  }
  return best
}

/** 提交给上游时：auto 不传 aspect_ratio */
export function videoAspectRatioForApi(
  value: VideoAspectRatioSetting,
): string | undefined {
  return value === 'auto' ? undefined : value
}

export function videoResolutionForApi(value: VideoResolutionSetting): string {
  return value
}

export function getVideoAspectRatioLabel(value: VideoAspectRatioSetting): string {
  return VIDEO_ASPECT_RATIO_OPTIONS.find((item) => item.value === value)?.label ?? value
}

export function getVideoResolutionLabel(value: VideoResolutionSetting): string {
  return VIDEO_RESOLUTION_OPTIONS.find((item) => item.value === value)?.label ?? value
}