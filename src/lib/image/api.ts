import { getActiveApiProfile, getCustomProviderDefinition } from '../shared/apiProfiles'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { getDataUrlDecodedByteSize } from './imageApiShared'
import { logger, serializeError } from '../shared/logger'
import { classifyError, reportEvent } from '../server/telemetry'
import { getApiRequestNetworkErrorHint, getUpstreamApiErrorHint } from '../task/taskErrorHints'
import { IMAGE_FETCH_CORS_HINT } from './imageApiShared'
import { applyTeamRuntimeSettings } from '../config/runtimeTeamSettings'
import { preflightImageUpstream } from './upstreamPreflight'
import {
  buildImageGenerationTelemetryBase,
  reportImageGenerationPersistOutcome,
  type ImageGenerationTelemetryBase,
  type ImagePersistTelemetryOutcome,
} from './imageTelemetry'

export type { CallApiOptions, CallApiResult } from './imageApiShared'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const effectiveSettings = applyTeamRuntimeSettings(opts.settings)
  const profile = getActiveApiProfile(effectiveSettings)
  const effectiveOpts = { ...opts, settings: effectiveSettings }
  const startedAt = Date.now()
  const appMode = opts.telemetry?.appMode ?? 'gallery'
  const deferSuccess = Boolean(opts.telemetry?.deferSuccessTelemetry)
  const baseEvent = {
    provider: profile.provider,
    app_mode: appMode,
    api_mode: profile.apiMode,
    model: profile.model,
    size: opts.params.size,
    quality: opts.params.quality,
    n_images: opts.params.n,
    has_input_image: opts.inputImageDataUrls.length > 0,
    input_image_count: opts.inputImageDataUrls.length,
    has_mask: Boolean(opts.maskDataUrl),
    prompt: opts.prompt,
    action_type: opts.telemetry?.actionType ?? 'generate',
    task_id: opts.telemetry?.taskId,
    image_index: opts.telemetry?.imageIndex,
  }
  const telemetryBase: ImageGenerationTelemetryBase = buildImageGenerationTelemetryBase({
    profile,
    appMode,
    prompt: opts.prompt,
    params: opts.params,
    inputImageCount: opts.inputImageDataUrls.length,
    hasMask: Boolean(opts.maskDataUrl),
    actionType: opts.telemetry?.actionType ?? 'generate',
    taskId: opts.telemetry?.taskId,
    imageIndex: opts.telemetry?.imageIndex,
  })
  logger.info('api', '图像 API 调用开始', {
    appMode,
    provider: profile.provider,
    profileName: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    streamImages: Boolean(profile.streamImages),
    edit: opts.inputImageDataUrls.length > 0,
    inputImages: opts.inputImageDataUrls.length,
    mask: Boolean(opts.maskDataUrl),
    promptChars: opts.prompt.length,
    params: opts.params,
  })

  try {
    await preflightImageUpstream(effectiveSettings, profile, opts.signal)
    const result = await callOpenAICompatibleImageApi(effectiveOpts, profile, getCustomProviderDefinition(effectiveSettings, profile.provider))
    const elapsedMs = Date.now() - startedAt
    logger.info('api', '图像 API 调用成功', {
      appMode,
      provider: profile.provider,
      model: profile.model,
      images: result.images.length,
      rawImageUrls: result.rawImageUrls?.length ?? 0,
      elapsedMs,
    })
    if (deferSuccess) {
      const reportPersistOutcome = (outcome: ImagePersistTelemetryOutcome, persistOpts?: { images?: string[]; err?: unknown; durationMs?: number }) =>
        reportImageGenerationPersistOutcome(telemetryBase, outcome, {
          durationMs: persistOpts?.durationMs ?? elapsedMs,
          images: persistOpts?.images ?? result.images,
          err: persistOpts?.err,
          awaitReport: opts.telemetry?.awaitReport,
        })
      return { ...result, reportPersistOutcome }
    }
    const event = {
      ...baseEvent,
      event_type: 'success',
      duration_ms: elapsedMs,
      output_count: result.images.length,
      output_bytes: result.images.reduce((sum, url) => sum + getDataUrlDecodedByteSize(url), 0),
    } as const
    if (opts.telemetry?.awaitReport) await reportEvent(event)
    else void reportEvent(event)
    return result
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    logger.error('api', '图像 API 调用失败', {
      appMode,
      provider: profile.provider,
      model: profile.model,
      apiMode: profile.apiMode,
      baseUrl: profile.baseUrl,
      elapsedMs,
      error: serializeError(err),
    })
    const cls = classifyError(err)
    let errorMessage = err instanceof Error ? err.message : String(err)
    const usesApiProxy = true
    const networkErrorHint = getApiRequestNetworkErrorHint(err, startedAt, usesApiProxy, profile)
    if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
      errorMessage += `\n${networkErrorHint}`
    } else {
      const upstreamHint = getUpstreamApiErrorHint(err)
      if (upstreamHint) errorMessage += `\n${upstreamHint}`
    }
    const event = {
      ...baseEvent,
      event_type: cls.error_type === 'cancelled' ? 'cancelled' : cls.error_type === 'timeout' ? 'timeout' : 'failure',
      duration_ms: elapsedMs,
      http_status: cls.http_status,
      error_type: cls.error_type,
      error_message: errorMessage,
      error_stack: err instanceof Error ? err.stack : undefined,
    } as const
    if (opts.telemetry?.awaitReport) await reportEvent(event)
    else void reportEvent(event)
    throw err
  }
}
