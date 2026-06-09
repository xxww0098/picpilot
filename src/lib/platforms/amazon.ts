import type { AgentPlatformDefinition } from './types'

export const amazonPlatform: AgentPlatformDefinition = {
  id: 'amazon',
  label: 'Amazon',
  shortLabel: 'Amazon',
  description: '预留 Amazon 主图、副图、生活方式图、A+ 和广告素材。',
  enabled: false,
  assetSlots: [],
  starterPrompts: [],
  buildInstructions: () => '',
}
