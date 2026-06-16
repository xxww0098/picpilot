import { describe, expect, it } from 'vitest'
import { calculateImageSize, formatImageRatio } from './size'

describe('calculateImageSize', () => {
  it('uses common 16:9 display resolutions for the built-in tiers', () => {
    expect(calculateImageSize('1K', '16:9')).toBe('1280x720')
    expect(calculateImageSize('2K', '16:9')).toBe('2560x1440')
    expect(calculateImageSize('4K', '16:9')).toBe('3840x2160')
  })

  it('uses matching portrait presets for common ratios', () => {
    expect(calculateImageSize('2K', '9:16')).toBe('1440x2560')
    expect(calculateImageSize('2K', '2:3')).toBe('1440x2160')
    expect(calculateImageSize('2K', '3:4')).toBe('1536x2048')
  })

  it('falls back to budget-based sizing for custom ratios', () => {
    expect(calculateImageSize('2K', '5:4')).toBe('2288x1824')
  })
})

describe('formatImageRatio', () => {
  it('displays clean simplified ratios exactly, not as an unreduced equivalent', () => {
    // 回归：1600x2000 应约分为 4:5 精确展示，而非 ≈8:10
    expect(formatImageRatio(1600, 2000)).toBe('4:5')
    expect(formatImageRatio(2000, 1600)).toBe('5:4')
    expect(formatImageRatio(1200, 1000)).toBe('6:5')
    expect(formatImageRatio(800, 1000)).toBe('4:5')
  })

  it('keeps exact common ratios', () => {
    expect(formatImageRatio(1920, 1080)).toBe('16:9')
    expect(formatImageRatio(1024, 1024)).toBe('1:1')
  })

  it('approximates near-square and odd ratios with a ≈ prefix', () => {
    expect(formatImageRatio(1040, 1024)).toBe('≈1:1')
  })
})
