import type { AgentPlatformAssetPlanItem, AgentPlatformBrief, AgentPlatformId, TaskRecord } from '../../types'

export interface AgentPlatformAssetSlot {
  id: string
  label: string
  platformId: AgentPlatformId
  description: string
  defaultAspectRatio?: string
  minCount?: number
  maxCount?: number
  required?: boolean
}

export interface AgentPlatformStarterPrompt {
  id: string
  title: string
  description: string
  prompt: string
  targetAssetSlotId?: string
}

export interface AgentPlatformPromptContext {
  brief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
  targetAssetSlotId?: string | null
}

export interface AgentPlatformAssetValidationInput {
  task: TaskRecord
  slot: AgentPlatformAssetSlot
}

export interface AgentPlatformValidationResult {
  warnings: string[]
}

export interface AgentPlatformDefinition {
  id: AgentPlatformId
  label: string
  shortLabel: string
  description: string
  enabled: boolean
  assetSlots: AgentPlatformAssetSlot[]
  starterPrompts: AgentPlatformStarterPrompt[]
  buildInstructions: (context: AgentPlatformPromptContext) => string
  validateAsset?: (asset: AgentPlatformAssetValidationInput) => AgentPlatformValidationResult
}
