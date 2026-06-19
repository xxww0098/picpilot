import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_RESOLUTION,
  normalizeVideoAspectRatio,
  normalizeVideoDurationChoice,
  normalizeVideoResolution,
  videoAspectRatioForApi,
  videoResolutionForApi,
} from './videoCapabilities'

describe('videoCapabilities', () => {
  it('normalizeVideoAspectRatio 接受合法比例并回退非法值', () => {
    expect(normalizeVideoAspectRatio('9:16')).toBe('9:16')
    expect(normalizeVideoAspectRatio('bad', '1:1')).toBe('1:1')
    expect(normalizeVideoAspectRatio(undefined)).toBe(DEFAULT_VIDEO_ASPECT_RATIO)
  })

  it('normalizeVideoResolution 仅允许 480p/720p', () => {
    expect(normalizeVideoResolution('480p')).toBe('480p')
    expect(normalizeVideoResolution('4k', '720p')).toBe('720p')
    expect(normalizeVideoResolution(undefined)).toBe(DEFAULT_VIDEO_RESOLUTION)
  })

  it('normalizeVideoDurationChoice 对齐到可选秒数', () => {
    expect(normalizeVideoDurationChoice(10, 6)).toBe(10)
    expect(normalizeVideoDurationChoice(7, 6)).toBe(6)
    expect(normalizeVideoDurationChoice(14, 6)).toBe(15)
  })

  it('videoAspectRatioForApi auto 时不传', () => {
    expect(videoAspectRatioForApi('auto')).toBeUndefined()
    expect(videoAspectRatioForApi('16:9')).toBe('16:9')
  })

  it('videoResolutionForApi 原样传递', () => {
    expect(videoResolutionForApi('720p')).toBe('720p')
  })
})