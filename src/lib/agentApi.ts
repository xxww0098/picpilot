import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { createDefaultOpenAIProfile, explicitUpstreamModeHeader, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { chatModelSupportsHostedImageTool, getAgentImageEngine } from './chatModels'
import { callImageApi } from './api'
import { getStoredAuthToken } from './auth'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage, MIME_MAP, normalizeBase64Image } from './imageApiShared'
import { logger, serializeError } from './logger'
import { classifyError, reportEvent } from './telemetry'
import { applyTeamRuntimeSettings } from './runtimeTeamSettings'
import { AGENT_TITLE_INSTRUCTIONS, createAgentInstructions, createAgentTools, resolveAgentModel } from './agentApiInstructions'
import { extractImageFromOutputItem, extractImages, extractText, getNumberValue, getStreamResponsePayload, getStringValue, isEventStreamResponse, isRecordValue, parseAgentConversationTitleXml, parseAgentStreamResponse, readJsonServerSentEvents, throwIfAborted } from './agentApiParsing'
import type { AgentApiPlatformContext, AgentApiResult, AgentApiResultImage, BatchImageCallResult } from './agentApiTypes'

export type { AgentApiMessage, AgentApiPlatformContext, AgentApiResult, AgentApiResultImage, BatchImageCallResult } from './agentApiTypes'

function createHeaders(profile: ApiProfile, includeAppAuth = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = profile.apiKey.trim()
  if (!includeAppAuth && apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (includeAppAuth) {
    const upstreamMode = explicitUpstreamModeHeader(profile.upstreamMode)
    if (upstreamMode) headers['X-PicPilot-Upstream-Mode'] = upstreamMode
    const token = getStoredAuthToken()
    if (token) headers['X-PicPilot-Authorization'] = `Bearer ${token}`
  }
  return headers
}

export async function callAgentResponsesApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  params: TaskParams
  input: unknown
  telemetry?: {
    prompt?: string
    roundId?: string
    inputImageCount?: number
    hasMask?: boolean
  }
  maskDataUrl?: string
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
  platformContext?: AgentApiPlatformContext
}): Promise<AgentApiResult> {
  const settings = applyTeamRuntimeSettings(opts.settings)
  const profile = { ...opts.profile, timeout: getActiveApiProfile(settings).timeout }
  const { params, input, maskDataUrl, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const model = resolveAgentModel(profile, settings)
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const body: Record<string, unknown> = {
      model,
      instructions: createAgentInstructions(settings, chatModelSupportsHostedImageTool(model), opts.platformContext),
      input,
      tools: createAgentTools(params, profile, settings, maskDataUrl),
    }
    if (profile.streamImages) {
      body.stream = true
    }

    logger.info('api', 'Agent Responses API 调用开始', {
      appMode: 'agent',
      provider: profile.provider,
      model,
      apiMode: 'responses',
      apiProxy: useApiProxy,
      inputImages: opts.telemetry?.inputImageCount ?? 0,
      mask: Boolean(opts.telemetry?.hasMask ?? maskDataUrl),
      stream: Boolean(profile.streamImages),
    })

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile, useApiProxy),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    let result: AgentApiResult
    if (profile.streamImages && isEventStreamResponse(response)) {
      result = await parseAgentStreamResponse(response, mime, controller.signal, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted)
    } else {
      const payload = await response.json() as ResponsesApiResponse
      throwIfAborted(controller.signal, signal)
      result = {
        responseId: payload.id,
        text: extractText(payload),
        images: extractImages(payload, mime),
        outputItems: payload.output,
        rawResponsePayload: JSON.stringify(payload, null, 2),
      }
    }

    const elapsedMs = Date.now() - startedAt
    const outputItemCount = result.outputItems?.length ?? 0
    logger.info('api', 'Agent Responses API 调用成功', {
      appMode: 'agent',
      provider: profile.provider,
      model,
      outputItems: outputItemCount,
      images: result.images.length,
      textChars: result.text.length,
      elapsedMs,
    })
    void reportEvent({
      event_type: 'success',
      app_mode: 'agent',
      provider: profile.provider,
      api_mode: 'responses',
      model,
      prompt: opts.telemetry?.prompt,
      action_type: 'agent_message',
      task_id: opts.telemetry?.roundId,
      has_input_image: (opts.telemetry?.inputImageCount ?? 0) > 0,
      input_image_count: opts.telemetry?.inputImageCount ?? 0,
      has_mask: Boolean(opts.telemetry?.hasMask ?? maskDataUrl),
      duration_ms: elapsedMs,
      output_count: result.images.length,
    })
    return result
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    logger.error('api', 'Agent Responses API 调用失败', {
      appMode: 'agent',
      provider: profile.provider,
      model,
      elapsedMs,
      error: serializeError(err),
    })
    const cls = classifyError(err)
    void reportEvent({
      event_type: cls.error_type === 'cancelled' ? 'cancelled' : cls.error_type === 'timeout' ? 'timeout' : 'failure',
      app_mode: 'agent',
      provider: profile.provider,
      api_mode: 'responses',
      model,
      prompt: opts.telemetry?.prompt,
      action_type: 'agent_message',
      task_id: opts.telemetry?.roundId,
      has_input_image: (opts.telemetry?.inputImageCount ?? 0) > 0,
      input_image_count: opts.telemetry?.inputImageCount ?? 0,
      has_mask: Boolean(opts.telemetry?.hasMask ?? maskDataUrl),
      duration_ms: elapsedMs,
      http_status: cls.http_status,
      error_type: cls.error_type,
      error_message: err instanceof Error ? err.message : String(err),
      error_stack: err instanceof Error ? err.stack : undefined,
    })
    throw err
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function callAgentConversationTitleApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  prompt: string
  imageDataUrls?: string[]
  signal?: AbortSignal
}): Promise<string> {
  const settings = applyTeamRuntimeSettings(opts.settings)
  const profile = { ...opts.profile, timeout: getActiveApiProfile(settings).timeout }
  const { prompt, imageDataUrls, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  const startedAt = Date.now()
  try {
    const content: Array<Record<string, string>> = [
      { type: 'input_text', text: `The following is the first message the user sent in a conversation. Generate a title for this conversation.\n\n${prompt}` },
    ]
    for (const dataUrl of imageDataUrls ?? []) {
      content.push({ type: 'input_image', image_url: dataUrl })
    }

    logger.info('api', 'Agent 会话标题生成开始', { provider: profile.provider, model: resolveAgentModel(profile, settings) })
    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile, useApiProxy),
      cache: 'no-store',
      body: JSON.stringify({
        model: resolveAgentModel(profile, settings),
        instructions: AGENT_TITLE_INSTRUCTIONS,
        input: [{ role: 'user', content }],
        max_output_tokens: 32,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMsg = await getApiErrorMessage(response)
      logger.error('api', `Agent 会话标题生成失败 (HTTP ${response.status})`, { elapsedMs: Date.now() - startedAt, error: errorMsg })
      throw new Error(errorMsg)
    }

    const payload = await response.json() as ResponsesApiResponse
    const title = parseAgentConversationTitleXml(extractText(payload))
    logger.info('api', 'Agent 会话标题生成成功', { elapsedMs: Date.now() - startedAt, title })
    return title
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

// ---------------------------------------------------------------------------
// Batch image generation: execute a single image via Responses API
// Uses the same pattern as gallery Responses API mode:
//   - PROMPT_REWRITE_GUARD to prevent prompt modification
//   - tool_choice: 'required' to force immediate generation
//   - Reference images passed as input_image
// ---------------------------------------------------------------------------

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

/**
 * Generate a single image using Responses API with prompt-rewrite guard.
 * This mirrors the gallery mode's callResponsesImageApiSingle pattern.
 */
// grok 等无托管图像工具的对话模型：用 Images API（engine，如 grok-imagine-image）实际出图。
// 合成一个仅含 openai images 配置的 settings 交给 callImageApi，复用画廊那套出图/流式/结果解析。
async function generateBatchImageViaImagesApi(opts: {
  settings: AppSettings
  engine: string
  profile: ApiProfile
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  const { settings, engine, profile, params, batchItemId, prompt, referenceImageDataUrls, signal, onImageToolStarted, onPartialImage, onImageToolCompleted } = opts
  const imageProfile = createDefaultOpenAIProfile({
    provider: 'xAI',
    model: engine,
    apiMode: 'images',
    timeout: profile.timeout,
    streamImages: profile.streamImages,
    streamPartialImages: profile.streamPartialImages,
  })
  const imageSettings = normalizeSettings({
    ...settings,
    customProviders: [],
    profiles: [imageProfile],
    activeProfileId: imageProfile.id,
    model: engine,
    apiMode: 'images',
    codexCli: false,
  })

  try {
    await onImageToolStarted?.()
    const result = await callImageApi({
      settings: imageSettings,
      prompt,
      params,
      telemetry: {
        actionType: 'generate',
        appMode: 'agent',
      },
      inputImageDataUrls: referenceImageDataUrls,
      onPartialImage: onPartialImage
        ? (partial) => { void onPartialImage({ image: partial.image, partialImageIndex: partial.partialImageIndex }) }
        : undefined,
      signal,
    })
    const dataUrl = result.images[0]
    if (!dataUrl) {
      return { batchItemId, image: null, error: result.failedErrors?.[0] ?? '图像生成失败，未返回图片。' }
    }
    const image: AgentApiResultImage = {
      dataUrl,
      actualParams: result.actualParams ?? result.actualParamsList?.[0],
      revisedPrompt: result.revisedPrompts?.[0],
    }
    await onImageToolCompleted?.(image)
    return { batchItemId, image, error: null }
  } catch (err) {
    logger.error('api', 'Batch 图片生成失败 (Images API fallback)', { batchItemId, error: serializeError(err) })
    return { batchItemId, image: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function callBatchImageSingle(opts: {
  settings: AppSettings
  profile: ApiProfile
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  referenceIds?: string[]
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  const settings = applyTeamRuntimeSettings(opts.settings)
  const profile = { ...opts.profile, timeout: getActiveApiProfile(settings).timeout }
  const { params, batchItemId, prompt, referenceImageDataUrls, referenceIds, signal, onImageToolStarted, onPartialImage, onImageToolCompleted } = opts

  // 对话模型不支持托管 image_generation 工具（grok）→ 改用 Images API（grok-imagine-image 等）实际出图。
  if (!chatModelSupportsHostedImageTool(resolveAgentModel(profile, settings))) {
    logger.info('api', 'Batch 图片生成 (Images API fallback)', { batchItemId, model: resolveAgentModel(profile, settings) })
    return generateBatchImageViaImagesApi({
      settings,
      engine: getAgentImageEngine(resolveAgentModel(profile, settings)),
      profile,
      params,
      batchItemId,
      prompt,
      referenceImageDataUrls,
      signal,
      onImageToolStarted,
      onPartialImage,
      onImageToolCompleted,
    })
  }

  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  const startedAt = Date.now()
  try {
    logger.info('api', 'Batch 图片生成开始 (Responses API)', { batchItemId, model: resolveAgentModel(profile, settings), hasReferences: referenceImageDataUrls.length > 0 })
    // Build input: reference id mapping + prompt-rewrite guard + reference images.
    const referenceMapping = referenceImageDataUrls.length > 0
      ? `Attached reference images correspond to these ids, in order: ${(referenceIds ?? []).map((id) => `<ref id="${id}" />`).join(', ') || 'reference images'}.`
      : ''
    const guardedPrompt = [referenceMapping, `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`].filter(Boolean).join('\n\n')
    let input: unknown
    if (referenceImageDataUrls.length > 0) {
      input = [{
        role: 'user',
        content: [
          { type: 'input_text', text: guardedPrompt },
          ...referenceImageDataUrls.map((dataUrl) => ({
            type: 'input_image',
            image_url: dataUrl,
          })),
        ],
      }]
    } else {
      input = guardedPrompt
    }

    // Build image_generation tool with current params
    const tool: Record<string, unknown> = {
      type: 'image_generation',
      action: referenceImageDataUrls.length > 0 ? 'auto' : 'generate',
      size: params.size,
      output_format: params.output_format,
      moderation: params.moderation,
      quality: params.quality,
    }
    if (params.output_format !== 'png' && params.output_compression != null) {
      tool.output_compression = params.output_compression
    }
    if (profile.streamImages) {
      tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
    }

    const body: Record<string, unknown> = {
      model: resolveAgentModel(profile, settings),
      input,
      tools: [tool],
      tool_choice: 'required',
    }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile, useApiProxy),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMsg = await getApiErrorMessage(response)
      return { batchItemId, image: null, error: errorMsg }
    }

    // Handle streaming
    if (profile.streamImages && isEventStreamResponse(response)) {
      await onImageToolStarted?.()
      let completedImage: AgentApiResultImage | null = null
      let rawPayload: string | undefined

      await readJsonServerSentEvents(response, async (event) => {
        const type = getStringValue(event, 'type')

        if (type === 'response.image_generation_call.partial_image') {
          const b64 = getStringValue(event, 'partial_image_b64')
          if (b64) {
            await onPartialImage?.({
              image: normalizeBase64Image(b64, mime),
              partialImageIndex: getNumberValue(event, 'partial_image_index'),
            })
          }
          return
        }

        if (type === 'response.output_item.done') {
          const payload = getStreamResponsePayload(event)
          const item = payload?.output?.[0]
          if (item) {
            const img = extractImageFromOutputItem(item, mime)
            if (img) {
              completedImage = img
              await onImageToolCompleted?.(img)
            }
          }
          return
        }

        if (type === 'response.completed' || isRecordValue(event.response)) {
          const payload = getStreamResponsePayload(event)
          if (payload) rawPayload = JSON.stringify(payload, null, 2)
          if (!completedImage && payload) {
            const images = extractImages(payload, mime)
            if (images.length > 0) {
              completedImage = images[0]
              await onImageToolCompleted?.(completedImage)
            }
          }
        }
      }, [controller.signal, signal])

      logger.info('api', 'Batch 图片生成完成 (streaming)', { batchItemId, elapsedMs: Date.now() - startedAt, hasImage: !!completedImage })
      return {
        batchItemId,
        image: completedImage,
        error: completedImage ? null : '流式响应未返回图片',
        rawResponsePayload: rawPayload,
      }
    }

    // Non-streaming
    const payload = await response.json() as ResponsesApiResponse
    const images = extractImages(payload, mime)
    const image = images[0] ?? null
    if (image) await onImageToolCompleted?.(image)
    logger.info('api', 'Batch 图片生成完成 (non-streaming)', { batchItemId, elapsedMs: Date.now() - startedAt, hasImage: !!image })
    return {
      batchItemId,
      image,
      error: image ? null : '接口未返回图片数据',
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } catch (err) {
    if (controller.signal.aborted || signal?.aborted) {
      logger.info('api', 'Batch 图片生成取消', { batchItemId, elapsedMs: Date.now() - startedAt })
      return { batchItemId, image: null, error: '请求已取消' }
    }
    logger.error('api', 'Batch 图片生成失败', { batchItemId, elapsedMs: Date.now() - startedAt, error: serializeError(err) })
    return { batchItemId, image: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** Parse the arguments of a generate_image_batch function call */
export function parseBatchImageCallArguments(args: string): Array<{ id: string; prompt: string }> | null {
  try {
    const parsed = JSON.parse(args) as { images?: unknown }
    if (!parsed || !Array.isArray(parsed.images)) return null
    const items: Array<{ id: string; prompt: string }> = []
    for (const raw of parsed.images) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
      if (!prompt) continue
      items.push({ id: id || `image_${items.length + 1}`, prompt })
    }
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}
