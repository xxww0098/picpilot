import type { SizeTier } from '../params/size'

export interface ImageProviderPreset {
  tiers: SizeTier[]
  ratios: { label: string; value: string }[]
  limitText: string
}

export interface ImageProviderCapabilities {
  /** 尺寸控制方式：pixels（GPT）= 自定义像素；aspect_ratio（Grok）= 比例+分辨率档 */
  sizeMode: 'pixels' | 'aspect_ratio'
  /** 是否支持 quality 参数 */
  supportsQuality: boolean
  /** 是否支持 output_format（png/jpeg/webp） */
  supportsOutputFormat: boolean
  /** 是否支持 output_compression */
  supportsCompression: boolean
  /** 是否支持 moderation 参数 */
  supportsModeration: boolean
  /** 尺寸选择器的预设 */
  sizePresets: ImageProviderPreset
  /** 当 sizeMode 为 aspect_ratio 时，是否支持自定义比例输入 */
  supportsCustomRatio: boolean
}

const GPT_PRESETS: ImageProviderPreset = {
  tiers: ['1K', '2K', '4K'],
  ratios: [
    { label: '1:1', value: '1:1' },
    { label: '3:2', value: '3:2' },
    { label: '2:3', value: '2:3' },
    { label: '16:9', value: '16:9' },
    { label: '9:16', value: '9:16' },
    { label: '4:3', value: '4:3' },
    { label: '3:4', value: '3:4' },
    { label: '21:9', value: '21:9' },
  ],
  limitText: '由于模型限制，最终输出会自动规整到合法尺寸：\n宽高均为 16 的倍数，最大边长 3840px，宽高比不超过 3:1，总像素限制为 655360-8294400。',
}

const GROK_PRESETS: ImageProviderPreset = {
  tiers: ['1K', '2K'],
  ratios: [
    { label: '1:1', value: '1:1' },
    { label: '16:9', value: '16:9' },
    { label: '9:16', value: '9:16' },
    { label: '4:3', value: '4:3' },
    { label: '3:4', value: '3:4' },
    { label: '3:2', value: '3:2' },
    { label: '2:3', value: '2:3' },
    { label: '2:1', value: '2:1' },
    { label: '1:2', value: '1:2' },
  ],
  limitText: 'Grok 使用宽高比 + 分辨率控制尺寸：\n1K ≈ 1024px 边长，2K ≈ 2048px 边长。不支持自定义像素值。',
}

const GEMINI_PRESETS: ImageProviderPreset = {
  tiers: ['1K', '2K'],
  ratios: [
    { label: '1:1', value: '1:1' },
    { label: '16:9', value: '16:9' },
    { label: '9:16', value: '9:16' },
    { label: '4:3', value: '4:3' },
    { label: '3:4', value: '3:4' },
  ],
  limitText: 'Gemini 使用宽高比 + 分辨率控制尺寸：\n1K ≈ 1024px 边长，2K ≈ 2048px 边长。',
}

const GPT_CAPABILITIES: ImageProviderCapabilities = {
  sizeMode: 'pixels',
  supportsQuality: true,
  supportsOutputFormat: true,
  supportsCompression: true,
  supportsModeration: true,
  sizePresets: GPT_PRESETS,
  supportsCustomRatio: true,
}

const GROK_CAPABILITIES: ImageProviderCapabilities = {
  sizeMode: 'aspect_ratio',
  supportsQuality: false,
  supportsOutputFormat: false,
  supportsCompression: false,
  supportsModeration: true,
  sizePresets: GROK_PRESETS,
  supportsCustomRatio: false,
}

const GEMINI_CAPABILITIES: ImageProviderCapabilities = {
  sizeMode: 'aspect_ratio',
  supportsQuality: false,
  supportsOutputFormat: false,
  supportsCompression: false,
  supportsModeration: false,
  sizePresets: GEMINI_PRESETS,
  supportsCustomRatio: false,
}

const PROVIDER_CAPABILITIES: Record<string, ImageProviderCapabilities> = {
  openai: GPT_CAPABILITIES,
  xai: GROK_CAPABILITIES,
  google: GEMINI_CAPABILITIES,
}

const DEFAULT_CAPABILITIES = GPT_CAPABILITIES

export function getProviderCapabilities(provider?: string): ImageProviderCapabilities {
  if (!provider) return DEFAULT_CAPABILITIES
  return PROVIDER_CAPABILITIES[provider.toLowerCase()] ?? DEFAULT_CAPABILITIES
}
