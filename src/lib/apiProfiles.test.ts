import { describe, expect, it } from 'vitest'
import {
  DEFAULT_XAI_IMAGES_MODEL,
  createDefaultOpenAIProfile,
  getApiProviderLabel,
  normalizeSettings,
  switchApiProfileProvider,
} from './apiProfiles'

describe('apiProfiles xAI provider', () => {
  it('keeps built-in xAI profiles and defaults to the quality image model', () => {
    const settings = normalizeSettings({
      profiles: [{
        id: 'xai-profile',
        name: 'xAI',
        provider: 'xAI',
        baseUrl: '',
        apiKey: '',
        model: '',
        timeout: 900,
        apiMode: 'responses',
        codexCli: true,
      }],
      activeProfileId: 'xai-profile',
    })

    const profile = settings.profiles[0]
    expect(profile.provider).toBe('xAI')
    expect(profile.apiMode).toBe('images')
    expect(profile.model).toBe(DEFAULT_XAI_IMAGES_MODEL)
    expect(profile.codexCli).toBe(false)
    expect(profile.streamImages).toBe(false)
  })

  it('switches an OpenAI profile to xAI without falling back to OpenAI defaults', () => {
    const switched = switchApiProfileProvider(createDefaultOpenAIProfile(), 'xAI')

    expect(switched.provider).toBe('xAI')
    expect(switched.apiMode).toBe('images')
    expect(switched.model).toBe(DEFAULT_XAI_IMAGES_MODEL)
    expect(getApiProviderLabel({}, 'xAI')).toBe('xAI Imagine')
  })
})
