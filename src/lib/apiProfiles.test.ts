import { describe, expect, it } from 'vitest'
import {
  DEFAULT_XAI_IMAGES_MODEL,
  createDefaultOpenAIProfile,
  explicitUpstreamModeHeader,
  getApiProviderLabel,
  normalizeSettings,
  normalizeUpstreamMode,
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

describe('apiProfiles upstream mode', () => {
  it('normalizes upstream mode and keeps it on OpenAI profiles', () => {
    expect(normalizeUpstreamMode(undefined)).toBe('server')
    expect(normalizeUpstreamMode('auto')).toBe('server')
    expect(normalizeUpstreamMode('chatgpt2api')).toBe('reverse')
    expect(normalizeUpstreamMode('unknown', 'reverse')).toBe('reverse')
    expect(createDefaultOpenAIProfile().upstreamMode).toBe('server')
    expect(explicitUpstreamModeHeader('server')).toBeUndefined()
    expect(explicitUpstreamModeHeader('api')).toBe('api')
    expect(explicitUpstreamModeHeader('reverse')).toBe('reverse')

    const settings = normalizeSettings({
      profiles: [{
        id: 'reverse-profile',
        name: 'Reverse',
        provider: 'openai',
        baseUrl: '',
        apiKey: '',
        model: 'gpt-image-2',
        timeout: 900,
        apiMode: 'images',
        upstreamMode: 'reverse',
        codexCli: false,
      }],
      activeProfileId: 'reverse-profile',
    })

    expect(settings.profiles[0].upstreamMode).toBe('reverse')
  })

  it('resets upstream mode for non-OpenAI built-in providers', () => {
    const settings = normalizeSettings({
      profiles: [{
        id: 'xai-profile',
        name: 'xAI',
        provider: 'xAI',
        baseUrl: '',
        apiKey: '',
        model: '',
        timeout: 900,
        apiMode: 'images',
        upstreamMode: 'reverse',
        codexCli: false,
      }],
      activeProfileId: 'xai-profile',
    })

    expect(settings.profiles[0].upstreamMode).toBe('api')
  })
})
