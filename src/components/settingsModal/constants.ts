// 从 SettingsModal.tsx 抽出的纯常量与无状态辅助函数（自定义服务商表单/导入相关）。
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_SETTINGS,
  findEquivalentApiProfile,
} from '../../lib/shared/apiProfiles'
import type { ApiProfile, AppSettings, CustomProviderDefinition } from '../../types'

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export const ADD_CUSTOM_PROVIDER_VALUE = '__add_custom_provider__'

export interface CustomProviderForm {
  json: string
}

export const DEFAULT_CUSTOM_PROVIDER_MANIFEST = {
  name: '自定义服务商',
  submit: {
    path: 'images/generations',
    method: 'POST',
    contentType: 'json',
    body: {
      model: '$profile.model',
      prompt: '$prompt',
      size: '$params.size',
      quality: '$params.quality',
      output_format: '$params.output_format',
      moderation: '$params.moderation',
      output_compression: '$params.output_compression',
      n: '$params.n',
    },
    result: {
      imageUrlPaths: ['data.*.url'],
      b64JsonPaths: ['data.*.b64_json'],
    },
  },
  editSubmit: {
    path: 'images/edits',
    method: 'POST',
    contentType: 'multipart',
    body: {
      model: '$profile.model',
      prompt: '$prompt',
      size: '$params.size',
      quality: '$params.quality',
      output_format: '$params.output_format',
      moderation: '$params.moderation',
      output_compression: '$params.output_compression',
      n: '$params.n',
    },
    files: [
      { field: 'image[]', source: 'inputImages', array: true },
      { field: 'mask', source: 'mask' },
    ],
    result: {
      imageUrlPaths: ['data.*.url'],
      b64JsonPaths: ['data.*.b64_json'],
    },
  },
}

export function createDefaultCustomProviderForm(): CustomProviderForm {
  return {
    json: JSON.stringify(DEFAULT_CUSTOM_PROVIDER_MANIFEST, null, 2),
  }
}

export function customProviderToForm(provider: CustomProviderDefinition): CustomProviderForm {
  return {
    json: JSON.stringify({
      name: provider.name,
      submit: provider.submit,
      editSubmit: provider.editSubmit,
      poll: provider.poll,
    }, null, 2),
  }
}

export function customProviderFormToInput(form: CustomProviderForm) {
  return JSON.parse(form.json)
}

export function isPristineNewOpenAIProfile(profile: ApiProfile) {
  const defaultProfile = createDefaultOpenAIProfile({ id: profile.id, name: '新配置' })
  return profile.name === '新配置' &&
    profile.provider === 'openai' &&
    profile.baseUrl === DEFAULT_SETTINGS.baseUrl &&
    profile.apiKey === '' &&
    profile.model === DEFAULT_IMAGES_MODEL &&
    profile.timeout === DEFAULT_SETTINGS.timeout &&
    profile.apiMode === 'images' &&
    profile.codexCli === false &&
    profile.streamImages === defaultProfile.streamImages &&
    profile.streamPartialImages === defaultProfile.streamPartialImages
}

export function getImportedProfileFromMergedSettings(
  nextSettings: AppSettings,
  previousProfileIds: Set<string>,
  importedSettings: { customProviders: CustomProviderDefinition[], profiles: ApiProfile[] },
) {
  const existingProfile = importedSettings.profiles
    .map((profile) => findEquivalentApiProfile(nextSettings, profile, importedSettings.customProviders))
    .find((profile): profile is ApiProfile => profile != null && previousProfileIds.has(profile.id))
  if (existingProfile) return existingProfile

  return nextSettings.profiles.find((profile) => !previousProfileIds.has(profile.id)) ?? nextSettings.profiles[0]
}

export function isAsyncCustomProvider(provider: CustomProviderDefinition | null | undefined) {
  return Boolean(provider?.poll || provider?.submit.taskIdPath || provider?.editSubmit?.taskIdPath)
}

export const CUSTOM_PROVIDER_LLM_PROMPT = `# 角色
你是 API 文档解析助手。你的任务是根据用户提供的图像生成 API 文档，生成本应用可导入的自定义服务商配置 JSON。

# 工作流程
1. 先向用户索要 API 文档链接或完整文档文本。
2. 如果当前环境支持读取链接，主动读取；否则要求用户粘贴文档内容。
3. 在未获得文档前不要猜测，不要生成占位配置。
4. 从文档中判断文生图提交接口、图生图接口和同步响应里的结果图片路径。
5. 仅生成同步返回图片的配置；如果文档只提供异步 task_id / poll 流程，说明当前团队代理模式暂不支持该服务商。
6. 如果文档中明确了默认模型 ID，在 profiles 中填入；如果未明确模型 ID，model 使用 "gpt-image-2"；baseUrl 固定留空。
7. 输出最终 JSON；不要索要 API Key。

# 输出结构
输出 JSON 包含两个顶层字段：
- customProviders：自定义服务商 Manifest 数组，每项描述一个服务商的接口映射规则。
- profiles：API 与模型配置数组，每项描述一个可直接使用的连接配置，引用 customProviders 中的服务商。

## customProviders 元素（Manifest）
每个元素的顶层字段：id、name、submit、editSubmit。
id 是服务商的唯一标识，用于 profiles 中的 provider 字段引用，建议使用 custom-{英文短名} 格式。
submit 是文生图提交配置，必填。
editSubmit 是图生图或局部重绘提交配置，可选。如果文生图和图生图使用同一个 JSON 接口，可以省略 editSubmit，并在 submit.body 中加入 image_urls。
不要输出 poll；团队 API 代理模式只支持同步返回图片的自定义服务商。

submit/editSubmit 字段：
- path：接口路径，不带开头斜杠，不带 /v1/ 前缀，例如 images/generations 或 tasks/{task_id}。
- method：GET 或 POST，默认 POST。
- contentType：json 或 multipart。
- query：提交 query 参数对象，可选，例如 {"async":"true"}。
- body：请求体模板对象。
- files：multipart 文件字段数组，仅 contentType=multipart 时使用。
- taskIdPath：不要输出；团队 API 代理模式暂不支持异步任务服务商。
- result：同步响应图片提取规则。

result 字段：
- imageUrlPaths：图片 URL 路径数组，支持 * 通配数组。例如 data.*.url、data.result.images.*.url.*。
- b64JsonPaths：base64 图片路径数组，支持 * 通配数组。例如 data.*.b64_json。

body 模板变量：
- $profile.model：用户在设置里填写的模型 ID。
- $prompt：当前提示词。
- $params.size、$params.quality、$params.output_format、$params.output_compression、$params.moderation、$params.n：应用内参数。
- $inputImages.dataUrls：参考图 data URL 数组；没有参考图时会自动省略该字段。
- $mask.dataUrl：遮罩图 data URL；没有遮罩时会自动省略该字段。

multipart files 示例：
- {"field":"image[]","source":"inputImages","array":true}
- {"field":"mask","source":"mask"}

## profiles 元素
每个元素的字段：
- name：配置名称，方便用户识别。
- provider：对应 customProviders 中某个元素的 id。
- baseUrl：留空字符串 ""，实际地址由部署端的团队 API 代理决定。
- model：模型 ID。如果 API 文档明确了默认模型，填入该值；否则使用 "gpt-image-2"。
- apiMode：固定为 "images"。

profiles 中不要包含 apiKey（团队代理会注入服务器侧 Key）。

# 输出要求
- 最终回复只包含一个 \`\`\`json 代码块，代码块内是 JSON 对象。
- JSON 对象必须包含 customProviders 和 profiles 两个顶层字段。
- 代码块外不要附加解释文字。
- 不要输出 API Key、Authorization header。
- 不要输出 taskIdPath 或 poll；如果文档返回 task_id，请改为提示该服务商当前不适配团队代理模式。
- 如果结果 URL 是数组，路径必须写到数组元素，例如 data.result.images.*.url.*。

## 同步接口示例
{"customProviders":[{"id":"custom-example-sync","name":"示例同步服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","quality":"$params.quality","output_format":"$params.output_format","moderation":"$params.moderation","output_compression":"$params.output_compression","n":"$params.n"},"result":{"imageUrlPaths":["data.*.url"],"b64JsonPaths":["data.*.b64_json"]}},"editSubmit":{"path":"images/edits","method":"POST","contentType":"multipart","body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","quality":"$params.quality","output_format":"$params.output_format","moderation":"$params.moderation","output_compression":"$params.output_compression","n":"$params.n"},"files":[{"field":"image[]","source":"inputImages","array":true},{"field":"mask","source":"mask"}],"result":{"imageUrlPaths":["data.*.url"],"b64JsonPaths":["data.*.b64_json"]}}}],"profiles":[{"name":"示例同步服务商","provider":"custom-example-sync","baseUrl":"","model":"example-model-v1","apiMode":"images"}]}`
