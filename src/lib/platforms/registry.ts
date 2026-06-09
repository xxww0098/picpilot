import type { AgentPlatformId } from '../../types'
import { amazonPlatform } from './amazon'
import { independentSitePlatform } from './independentSite'
import { ozonPlatform } from './ozon'
import { shopifyPlatform } from './shopify'
import type { AgentPlatformAssetSlot, AgentPlatformDefinition } from './types'

export const agentPlatformDefinitions: AgentPlatformDefinition[] = [
  ozonPlatform,
  independentSitePlatform,
  amazonPlatform,
  shopifyPlatform,
]

const agentPlatformDefinitionById = new Map<AgentPlatformId, AgentPlatformDefinition>(
  agentPlatformDefinitions.map((platform) => [platform.id, platform]),
)

const knownAgentPlatformIds = new Set<AgentPlatformId>([
  ...agentPlatformDefinitions.map((platform) => platform.id),
  'generic_legacy',
])

export function getAgentPlatformDefinition(platformId: AgentPlatformId | string | null | undefined): AgentPlatformDefinition | null {
  if (!platformId) return null
  return agentPlatformDefinitionById.get(platformId as AgentPlatformId) ?? null
}

export function getEnabledAgentPlatforms(): AgentPlatformDefinition[] {
  return agentPlatformDefinitions.filter((platform) => platform.enabled)
}

export function getAgentPlatformAssetSlot(platformId: AgentPlatformId | string | null | undefined, slotId: string | null | undefined): AgentPlatformAssetSlot | null {
  if (!slotId) return null
  const platform = getAgentPlatformDefinition(platformId)
  if (!platform) return null
  return platform.assetSlots.find((slot) => slot.id === slotId && slot.platformId === platform.id) ?? null
}

export function normalizeAgentPlatformId(value: unknown): AgentPlatformId {
  return typeof value === 'string' && knownAgentPlatformIds.has(value as AgentPlatformId)
    ? value as AgentPlatformId
    : 'generic_legacy'
}
