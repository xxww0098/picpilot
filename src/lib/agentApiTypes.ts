import type { AgentPlatformAssetPlanItem, AgentPlatformBrief, AgentPlatformId, ResponsesApiResponse, TaskParams } from '../types'

export interface AgentApiMessage {
  role: 'user' | 'assistant'
  text: string
  imageDataUrls?: string[]
}

export interface AgentApiResultImage {
  toolCallId?: string
  action?: string
  dataUrl: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}

export interface AgentApiResult {
  responseId?: string
  text: string
  images: AgentApiResultImage[]
  outputItems: ResponsesApiResponse['output']
  rawResponsePayload?: string
}

export interface AgentApiPlatformContext {
  platformId?: AgentPlatformId
  brief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
  targetAssetSlotId?: string | null
}

export interface BatchImageCallResult {
  /** The batch item id from the model's function call */
  batchItemId: string
  image: AgentApiResultImage | null
  error: string | null
  rawResponsePayload?: string
}
