import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { getOutputImageLimitForSettings, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('keeps OpenAI streaming output count so the request can disable streaming', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4 }, settings).n).toBe(4)
  })

  it('falls back to the first team-allowed output format', () => {
    const result = normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, output_format: 'png', output_compression: null },
      DEFAULT_SETTINGS,
      { allowedOutputFormats: ['jpeg', 'webp'] },
    )

    expect(result.output_format).toBe('jpeg')
  })

  it('clears compression when team policy forces PNG output', () => {
    const result = normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, output_format: 'jpeg', output_compression: 80 },
      DEFAULT_SETTINGS,
      { allowedOutputFormats: ['png'] },
    )

    expect(result.output_format).toBe('png')
    expect(result.output_compression).toBeNull()
  })
})
