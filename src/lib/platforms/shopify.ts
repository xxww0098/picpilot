import type { AgentPlatformDefinition } from './types'

export const shopifyPlatform: AgentPlatformDefinition = {
  id: 'shopify',
  label: 'Shopify',
  shortLabel: 'Shopify',
  description: '预留 Shopify 商品媒体、变体图、集合页图和店铺模块图。',
  enabled: false,
  assetSlots: [],
  starterPrompts: [],
  buildInstructions: () => '',
}
