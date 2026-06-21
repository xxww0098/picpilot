// 画布模式的 AI 出图：复用 agent 链路的 callAgentResponsesApi（gpt-5.5 托管 image_generation 工具），
// 但不依赖 AgentConversation/Round 体系——画布完全独立存储。
//
// 与现有 agentOrchestrator 的区别：
// - 不做多轮工具循环（continue_generation / batch）——画布是「单次请求 → 单张/几张图 → 写回占位框」
// - 不创建 TaskRecord / AgentRound（产出图直接写回画布 + 镜像进画廊 images store）
// - 参考图来自画布上选中的 image shape（图生图 / 标注迭代）
import type { AppSettings, TaskParams } from '../../types'
import { DEFAULT_PARAMS } from '../../types'
import { callAgentResponsesApi, type AgentApiResultImage } from '../agent/agentApi'
import { getActiveApiProfile, normalizeSettings, validateApiProfile } from '../shared/apiProfiles'
import { storeImage } from '../shared/db'
import { cacheImage } from '../../store/imageCache'
import { normalizeParamsForSettings } from '../params/paramCompatibility'
import { getUserFacingErrorMessage } from '../shared/userFacingText'

export interface CanvasGenerateOptions {
  prompt: string
  /** 参考图 dataUrl 列表（图生图 / 标注迭代时传入） */
  inputImageDataUrls?: string[]
  /** mask dataUrl（局部编辑，未来启用） */
  maskDataUrl?: string
  /** 目标尺寸提示（来自占位框宽高比）；不传则用 settings 默认 */
  params?: Partial<TaskParams>
  signal?: AbortSignal
  /** 流式预览回调 */
  onPartialImage?: (image: string) => void
}

export interface CanvasGenerateResult {
  /** 生成图的 dataUrl（可能多张，单次画布请求通常 1 张） */
  images: AgentApiResultImage[]
  /** 助手文本（如有） */
  text: string
}

export interface CanvasGenerateError extends Error {
  readonly canvasErrorKind: 'config' | 'no-output' | 'api'
}

function makeCanvasError(kind: 'config' | 'no-output' | 'api', message: string): CanvasGenerateError {
  const err = new Error(message) as CanvasGenerateError
  ;(err as { canvasErrorKind: string }).canvasErrorKind = kind
  return err
}

/**
 * 画布单次出图。复用 gpt-5.5 的 Responses + image_generation 托管工具。
 * 返回生成图（dataUrl），调用方负责写回画布占位框。
 */
export async function generateCanvasImage(
  settings: AppSettings,
  options: CanvasGenerateOptions,
): Promise<CanvasGenerateResult> {
  const normalizedSettings = normalizeSettings(settings)
  const profile = getActiveApiProfile(normalizedSettings)
  const profileError = validateApiProfile(profile)
  if (profileError) {
    throw makeCanvasError('config', `API 与模型配置未完成：${profileError}`)
  }

  const inputImages = options.inputImageDataUrls ?? []
  const params = {
    ...normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, ...options.params },
      normalizedSettings,
      { hasInputImages: inputImages.length > 0 },
    ),
    // 画布单次请求固定 n=1（一次出一张填一个占位框；多占位框由用户多次触发）
    n: 1 as const,
  }

  // 构建 Responses API input：user message 含文本 + 可选参考图
  const userContent: unknown[] = [{ type: 'input_text', text: options.prompt }]
  for (const dataUrl of inputImages) {
    userContent.push({ type: 'input_image', image_url: dataUrl })
  }
  const input = [{ role: 'user', content: userContent }]

  let result
  try {
    result = await callAgentResponsesApi({
      settings: normalizedSettings,
      profile,
      params,
      input,
      maskDataUrl: options.maskDataUrl,
      signal: options.signal,
      telemetry: {
        prompt: options.prompt,
        inputImageCount: inputImages.length,
        hasMask: Boolean(options.maskDataUrl),
      },
      onImagePartialImage: options.onPartialImage ? ({ image }) => { options.onPartialImage?.(image) } : undefined,
    })
  } catch (err) {
    const message = getUserFacingErrorMessage(err, '画布出图失败')
    throw makeCanvasError('api', message)
  }

  if (!result.images || result.images.length === 0) {
    throw makeCanvasError(
      'no-output',
      result.text?.trim()
        ? '模型未生成图片。可尝试更明确的描述。'
        : '模型未返回图片，请重试或检查网络。',
    )
  }

  return { images: result.images, text: result.text ?? '' }
}

/**
 * 把生成图的 dataUrl 存入 IndexedDB images store（与画廊共享），返回 imageId。
 * 该 imageId 同时用作 tldraw image asset 的 id 后缀，便于持久化时剥离/恢复 dataUrl。
 */
export async function persistCanvasImage(dataUrl: string, source: 'generated' | 'mask' = 'generated'): Promise<string> {
  const imageId = await storeImage(dataUrl, source)
  cacheImage(imageId, dataUrl)
  return imageId
}
