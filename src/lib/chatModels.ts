// Agent 对话模型清单。顶栏的对话模型切换器据此渲染；新增可选模型在此登记即可。
// id 必须与 cliproxy /v1/models 的 model id 完全一致（会原样作为 Responses 请求的 model）。
export interface ChatModelOption {
  id: string
  label: string
  /** 模型来源，仅用于界面展示（tooltip） */
  provider: string
  // 是否支持 OpenAI Responses 的托管 image_generation 工具（即「边聊边出图」）。
  // gpt 系支持；grok 不支持（实测会忽略该工具返回文字）。不支持时 agent 出图改走 Images API。
  supportsHostedImageTool: boolean
  // 仅当 !supportsHostedImageTool 时使用：该对话模型在 agent 里实际出图所用的图像模型。
  imageEngine?: string
}

export const DEFAULT_AGENT_MODEL = 'gpt-5.5'
// 非 OpenAI 对话模型（如 grok）在 agent 里默认用它出图。
export const DEFAULT_AGENT_IMAGE_ENGINE = 'grok-imagine-image'

export const CHAT_MODELS: ChatModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI', supportsHostedImageTool: true },
  { id: 'grok-4.3', label: 'Grok 4.3', provider: 'xAI', supportsHostedImageTool: false, imageEngine: DEFAULT_AGENT_IMAGE_ENGINE },
]

export function getChatModel(id: string): ChatModelOption | undefined {
  return CHAT_MODELS.find((model) => model.id === id)
}

export function isKnownChatModel(id: string): boolean {
  return CHAT_MODELS.some((model) => model.id === id)
}

export function getChatModelLabel(id: string): string {
  return getChatModel(id)?.label ?? id
}

// 未知（用户自定义）模型默认按「支持托管工具」处理，保持既有行为——
// 既有逻辑本就要求 Responses 模式用支持 image_generation 的文本模型。
export function chatModelSupportsHostedImageTool(id: string): boolean {
  const model = getChatModel(id)
  return model ? model.supportsHostedImageTool : true
}

export function getAgentImageEngine(id: string): string {
  return getChatModel(id)?.imageEngine ?? DEFAULT_AGENT_IMAGE_ENGINE
}
