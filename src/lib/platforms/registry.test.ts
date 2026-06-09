import { describe, expect, it } from 'vitest'
import {
  getAgentPlatformAssetSlot,
  getAgentPlatformDefinition,
  getEnabledAgentPlatforms,
  normalizeAgentPlatformId,
} from './registry'

describe('agent platform registry', () => {
  it('exposes only Ozon and independent site as enabled platforms', () => {
    expect(getEnabledAgentPlatforms().map((platform) => platform.id)).toEqual(['ozon', 'independent_site'])
  })

  it('keeps Amazon and Shopify definitions disabled for future extension', () => {
    expect(getAgentPlatformDefinition('amazon')?.enabled).toBe(false)
    expect(getAgentPlatformDefinition('shopify')?.enabled).toBe(false)
  })

  it('normalizes invalid platform values to generic_legacy', () => {
    expect(normalizeAgentPlatformId('ozon')).toBe('ozon')
    expect(normalizeAgentPlatformId('independent_site')).toBe('independent_site')
    expect(normalizeAgentPlatformId('not-real')).toBe('generic_legacy')
    expect(normalizeAgentPlatformId(null)).toBe('generic_legacy')
  })

  it('looks up asset slots only within their owning platform', () => {
    expect(getAgentPlatformAssetSlot('ozon', 'ozon_main')?.label).toBe('主图')
    expect(getAgentPlatformAssetSlot('ozon', 'site_hero')).toBeNull()
    expect(getAgentPlatformAssetSlot('independent_site', 'site_hero')?.label).toBe('首屏图')
  })
})
