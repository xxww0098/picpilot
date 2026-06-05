// 团队 cliproxy 暴露的图像生成模型清单。
// 输入栏的模型选择器据此渲染；新增可选模型在此登记即可。
// 注意：id 必须与 cliproxy /v1/models 返回的 model id 完全一致，
// 因为它会原样作为请求体里的 `model` 字段发给上游。
export interface ImageModelOption {
  id: string
  label: string
  /** 模型来源，仅用于界面展示（tooltip / 副标），帮助用户区分与选择 */
  provider: string
}

export const IMAGE_MODELS: ImageModelOption[] = [
  { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'OpenAI' },
  { id: 'grok-imagine-image', label: 'Grok Imagine', provider: 'xAI' },
  { id: 'grok-imagine-image-quality', label: 'Grok Quality', provider: 'xAI' },
]

export function isKnownImageModel(id: string): boolean {
  return IMAGE_MODELS.some((model) => model.id === id)
}

export function getImageModelLabel(id: string): string {
  return IMAGE_MODELS.find((model) => model.id === id)?.label ?? id
}
