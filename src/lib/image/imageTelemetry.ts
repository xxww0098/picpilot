import type { ApiProfile } from '../../types'
import type { AppMode, TaskParams } from '../../types'
import type { CallApiResult } from './imageApiShared'
import { getDataUrlDecodedByteSize } from './imageApiShared'
import { classifyError, reportEvent, type TelemetryEvent } from '../server/telemetry'

export interface ImageGenerationTelemetryBase {
  provider: string
  app_mode: AppMode
  api_mode: string
  model: string
  size?: string
  quality?: string
  n_images?: number
  has_input_image: boolean
  input_image_count: number
  has_mask: boolean
  prompt: string
  action_type: string
  task_id?: string
  image_index?: number
}

export type ImagePersistTelemetryOutcome = 'success' | 'failure'

export function buildImageGenerationTelemetryBase(opts: {
  profile: ApiProfile
  appMode: AppMode
  prompt: string
  params: TaskParams
  inputImageCount: number
  hasMask: boolean
  actionType: string
  taskId?: string
  imageIndex?: number
}): ImageGenerationTelemetryBase {
  return {
    provider: opts.profile.provider,
    app_mode: opts.appMode,
    api_mode: opts.profile.apiMode,
    model: opts.profile.model,
    size: opts.params.size,
    quality: opts.params.quality,
    n_images: opts.params.n,
    has_input_image: opts.inputImageCount > 0,
    input_image_count: opts.inputImageCount,
    has_mask: opts.hasMask,
    prompt: opts.prompt,
    action_type: opts.actionType,
    task_id: opts.taskId,
    image_index: opts.imageIndex,
  }
}

export async function reportImageGenerationPersistOutcome(
  base: ImageGenerationTelemetryBase,
  outcome: ImagePersistTelemetryOutcome,
  opts: {
    durationMs: number
    images?: string[]
    err?: unknown
    awaitReport?: boolean
  },
): Promise<void> {
  const images = opts.images ?? []
  let event: TelemetryEvent
  if (outcome === 'success') {
    event = {
      ...base,
      event_type: 'success',
      duration_ms: opts.durationMs,
      output_count: images.length,
      output_bytes: images.reduce((sum, url) => sum + getDataUrlDecodedByteSize(url), 0),
    }
  } else {
    const err = opts.err
    const cls = classifyError(err)
    const message = err instanceof Error ? err.message : err != null ? String(err) : '本地保存失败'
    const isStorage =
      cls.error_type === 'unknown' &&
      (message.includes('存储') || message.toLowerCase().includes('quota') || message.toLowerCase().includes('storage'))
    event = {
      ...base,
      event_type: 'failure',
      duration_ms: opts.durationMs,
      error_type: isStorage ? 'storage_full' : cls.error_type,
      error_message: message,
      error_stack: err instanceof Error ? err.stack : undefined,
      output_count: 0,
    }
  }
  if (opts.awaitReport) await reportEvent(event)
  else void reportEvent(event)
}


/** 将 API 返回的图片写入 IndexedDB（经 store 注入），再上报遥测 success；失败则上报 failure 并抛出。 */
export async function persistGeneratedImagesAndReport(
  result: CallApiResult,
  storeOne: (dataUrl: string) => Promise<string>,
): Promise<string[]> {
  const report = result.reportPersistOutcome
  const persistStarted = Date.now()
  try {
    const ids: string[] = []
    for (const dataUrl of result.images) {
      ids.push(await storeOne(dataUrl))
    }
    if (report) {
      await report('success', { images: result.images, durationMs: Date.now() - persistStarted })
    }
    return ids
  } catch (err) {
    if (report) {
      await report('failure', { err, durationMs: Date.now() - persistStarted })
    }
    throw err
  }
}
