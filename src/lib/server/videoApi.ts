// grok-imagine-video（异步视频生成）客户端。
//
// 契约依据 xAI Imagine 文档（cliproxy 兼容）：
//   POST /v1/videos/generations  { model, prompt, duration?, aspect_ratio?, resolution?, image?: { url } } → 返回任务 id
//   GET  /v1/videos/{id}         → { status, ... , video.url(mp4) }，轮询至完成
// 因未对线上做真实探测（视频是付费异步任务），下面的字段解析做多形态容错。
// 真实契约差异等线上实测再校准。
import type { AppSettings } from '../../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../config/devProxy'
import { getStoredAuthToken } from '../shared/auth'
import { getApiErrorMessage } from '../image/imageApiShared'
import { logger, serializeError } from '../shared/logger'
import {
  normalizeVideoAspectRatio,
  normalizeVideoResolution,
  videoAspectRatioForApi,
  videoResolutionForApi,
  type VideoAspectRatioSetting,
  type VideoResolutionSetting,
} from '../video/videoCapabilities'
import { classifyError, reportEvent } from './telemetry'

export interface VideoGenerationResult {
  /** 生成的视频远端地址（mp4）。由调用方抓取后缓存到 IndexedDB。 */
  videoUrl: string
  /** 可选的封面图地址（部分实现会返回） */
  posterUrl?: string
  /** 原始响应，便于排查 */
  rawPayload?: string
}

export type VideoStatusClass = 'done' | 'failed' | 'pending'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 在嵌套对象/数组里按一组候选路径找第一个非空字符串。路径用点分，`*` 匹配数组首元素。
function findString(payload: unknown, paths: string[]): string | null {
  for (const path of paths) {
    let cur: unknown = payload
    for (const seg of path.split('.')) {
      if (seg === '*') {
        cur = Array.isArray(cur) ? cur[0] : undefined
      } else if (isRecord(cur)) {
        cur = cur[seg]
      } else {
        cur = undefined
      }
      if (cur == null) break
    }
    if (typeof cur === 'string' && cur.trim()) return cur.trim()
  }
  return null
}

// ----- 纯解析函数（可单测，不依赖网络）-----

export function extractVideoTaskId(payload: unknown): string | null {
  return findString(payload, ['id', 'request_id', 'task_id', 'data.id', 'data.request_id', 'data.task_id'])
}

export function extractVideoStatus(payload: unknown): string {
  return findString(payload, ['status', 'state', 'data.status', 'data.state']) ?? ''
}

export function classifyVideoStatus(status: string): VideoStatusClass {
  const s = status.toLowerCase()
  if (/(succeed|success|done|complete|finish|ready)/.test(s)) return 'done'
  if (/(fail|error|cancel|reject|expire)/.test(s)) return 'failed'
  return 'pending'
}

export function extractVideoUrl(payload: unknown): string | null {
  return findString(payload, [
    'video.url', 'video_url', 'url',
    'data.video.url', 'data.video_url', 'data.url',
    'output.url', 'output.video.url', 'output.*.url',
    'data.*.url', 'data.*.video.url',
    'result.url', 'result.video.url', 'result.*.url',
    'videos.*.url',
  ])
}

export function extractVideoPosterUrl(payload: unknown): string | undefined {
  return findString(payload, [
    'video.poster_url', 'video.thumbnail_url', 'poster_url', 'thumbnail_url',
    'data.video.poster_url', 'data.poster_url', 'data.thumbnail_url',
  ]) ?? undefined
}

export function extractVideoError(payload: unknown): string | undefined {
  return findString(payload, ['error.message', 'error', 'data.error', 'fail_reason', 'data.fail_reason', 'message']) ?? undefined
}

async function readVideoJsonPayload(response: Response, context: string): Promise<unknown> {
  const rawBody = await response.text().catch(() => '')
  if (!rawBody.trim()) {
    throw new Error(`${context} 返回空响应，无法解析视频任务结果。`)
  }

  try {
    return JSON.parse(rawBody) as unknown
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown'
    const preview = rawBody.replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`${context} 返回非 JSON 响应（Content-Type: ${contentType}）。请确认视频请求指向支持 /v1/videos/generations 的 xAI 上游接口。${preview ? `响应片段：${preview}` : ''}`)
  }
}

// ----- 网络：提交 + 轮询 -----

function createVideoHeaders(useApiProxy: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (useApiProxy) {
    const token = getStoredAuthToken()
    if (token) headers['X-PicPilot-Authorization'] = `Bearer ${token}`
  }
  return headers
}

export interface GenerateVideoOptions {
  settings: AppSettings
  model: string
  prompt: string
  /** 图生视频：参考图 data URL；不传则文生视频 */
  imageDataUrl?: string
  /** 视频时长（秒），不传则用上游默认 */
  durationSeconds?: number
  /** Grok 宽高比；auto 时不写入请求体 */
  aspectRatio?: VideoAspectRatioSetting
  /** Grok 分辨率：480p | 720p */
  resolution?: VideoResolutionSetting
  /** 轮询间隔（毫秒），默认 5000 */
  pollIntervalMs?: number
  /** 轮询总超时（毫秒），默认 10 分钟 */
  pollTimeoutMs?: number
  signal?: AbortSignal
  /** 进度回调：每次轮询拿到状态时触发 */
  onStatus?: (status: string) => void
}

const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function generateVideo(opts: GenerateVideoOptions): Promise<VideoGenerationResult> {
  const { model, prompt, imageDataUrl, durationSeconds, signal, onStatus } = opts
  const aspectRatio = normalizeVideoAspectRatio(opts.aspectRatio)
  const resolution = normalizeVideoResolution(opts.resolution)
  const startedAt = Date.now()
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const headers = createVideoHeaders(useApiProxy)

  const submitBody: Record<string, unknown> = { model, prompt }
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) submitBody.duration = durationSeconds
  const aspectForApi = videoAspectRatioForApi(aspectRatio)
  if (aspectForApi) submitBody.aspect_ratio = aspectForApi
  submitBody.resolution = videoResolutionForApi(resolution)
  if (imageDataUrl) submitBody.image = { url: imageDataUrl }

  logger.info('api', '视频 API 调用开始', {
    appMode: 'video',
    provider: 'xAI',
    model,
    apiMode: 'videos',
    apiProxy: useApiProxy,
    hasInputImage: Boolean(imageDataUrl),
    durationSeconds,
    aspectRatio,
    resolution,
    promptChars: prompt.length,
  })

  try {
    const submitResp = await fetch(buildApiUrl('', 'videos/generations', proxyConfig, useApiProxy), {
      method: 'POST',
      headers,
      cache: 'no-store',
      body: JSON.stringify(submitBody),
      signal,
    })
    if (!submitResp.ok) throw new Error(await getApiErrorMessage(submitResp, 'Videos /videos/generations'))
    const submitPayload = await readVideoJsonPayload(submitResp, 'Videos /videos/generations')

    const finishSuccess = (payload: unknown, videoUrl: string): VideoGenerationResult => {
      const elapsedMs = Date.now() - startedAt
      logger.info('api', '视频 API 调用成功', {
        appMode: 'video',
        provider: 'xAI',
        model,
        elapsedMs,
      })
      void reportEvent({
        event_type: 'success',
        app_mode: 'video',
        provider: 'xAI',
        api_mode: 'videos',
        model,
        prompt,
        action_type: 'generate_video',
        has_input_image: Boolean(imageDataUrl),
        input_image_count: imageDataUrl ? 1 : 0,
        duration_ms: elapsedMs,
        output_count: 1,
      })
      return { videoUrl, posterUrl: extractVideoPosterUrl(payload), rawPayload: JSON.stringify(payload) }
    }

    // 同步直返（部分实现可能直接给出 url）→ 立即返回
    const immediateUrl = extractVideoUrl(submitPayload)
    if (immediateUrl) return finishSuccess(submitPayload, immediateUrl)

    const taskId = extractVideoTaskId(submitPayload)
    if (!taskId) throw new Error('视频任务提交后未返回任务 id，无法轮询结果。')

    const deadline = Date.now() + pollTimeoutMs
    // 注：不用 Date.now() 做随机/缓存，仅作超时判断（轮询本就是运行期行为）。
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      await sleep(pollIntervalMs, signal)

      const pollResp = await fetch(buildApiUrl('', `videos/${encodeURIComponent(taskId)}`, proxyConfig, useApiProxy), {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal,
      })
      if (!pollResp.ok) throw new Error(await getApiErrorMessage(pollResp, 'Videos /videos/{id}'))
      const pollPayload = await readVideoJsonPayload(pollResp, 'Videos /videos/{id}')

      const status = extractVideoStatus(pollPayload)
      if (status) onStatus?.(status)
      const cls = classifyVideoStatus(status)

      // 即便状态字段缺失，只要拿到了 url 也视为完成。
      const url = extractVideoUrl(pollPayload)
      if (cls === 'done' || url) {
        if (!url) throw new Error('视频生成完成但未返回视频地址。')
        return finishSuccess(pollPayload, url)
      }
      if (cls === 'failed') {
        throw new Error(extractVideoError(pollPayload) || '视频生成失败。')
      }
      if (Date.now() > deadline) throw new Error('视频生成超时，请稍后在画廊查看或重试。')
    }
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    logger.error('api', '视频 API 调用失败', {
      appMode: 'video',
      provider: 'xAI',
      model,
      elapsedMs,
      error: serializeError(err),
    })
    const cls = classifyError(err)
    void reportEvent({
      event_type: cls.error_type === 'cancelled' ? 'cancelled' : cls.error_type === 'timeout' ? 'timeout' : 'failure',
      app_mode: 'video',
      provider: 'xAI',
      api_mode: 'videos',
      model,
      prompt,
      action_type: 'generate_video',
      has_input_image: Boolean(imageDataUrl),
      input_image_count: imageDataUrl ? 1 : 0,
      duration_ms: elapsedMs,
      http_status: cls.http_status,
      error_type: cls.error_type,
      error_message: err instanceof Error ? err.message : String(err),
      error_stack: err instanceof Error ? err.stack : undefined,
    })
    throw err
  }
}
