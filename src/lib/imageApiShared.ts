import type { AppSettings, TaskParams } from '../types'
import { logger, serializeError } from './logger'

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => void
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 并发批量生成（n>1）中失败的张数；部分成功时 > 0 */
  failedCount?: number
  /** 失败槽位的错误信息 */
  failedErrors?: string[]
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

export const IMAGE_FETCH_CORS_HINT = ' 可点链接按钮复制结果链接，或尝试开启「返回 Base64 图片数据」避免此问题。'

async function probeNoCorsReachability(url: string, timeoutMs = 8000): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  if (isDataUrl(url)) return url

  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      signal,
    })
  } catch (err) {
    if (err instanceof TypeError) {
      const probe = await probeNoCorsReachability(url)
      if (probe === 'opaque') {
        throw new Error(`图片已生成，但因服务商未允许跨域，图片链接下载失败。${IMAGE_FETCH_CORS_HINT}`)
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(`图片链接下载失败（网络不可用）。${IMAGE_FETCH_CORS_HINT}`)
      }
      throw new Error(`图片链接下载失败（可能因跨域限制、链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

export async function getApiErrorMessage(response: Response, context?: string): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  // 只读取一次响应体：先取文本再尝试解析 JSON，避免 response.json() 消费流后
  // text() 回退失败（旧实现的潜在 bug），同时可在日志中保留原始响应体。
  let rawBody = ''
  try {
    rawBody = await response.text()
  } catch {
    /* 响应体不可读 */
  }
  if (rawBody) {
    try {
      const errJson = JSON.parse(rawBody)
      if (errJson?.error?.message) errorMsg = errJson.error.message
      else if (typeof errJson?.detail === 'string') errorMsg = errJson.detail
      else if (Array.isArray(errJson?.detail)) errorMsg = errJson.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
      else if (typeof errJson?.error === 'string') errorMsg = errJson.error
      else if (errJson?.message) errorMsg = errJson.message
    } catch {
      errorMsg = rawBody.trim() || errorMsg
    }
  }
  if (context) {
    logger.warn('api', `${context} 请求失败 (HTTP ${response.status})`, {
      status: response.status,
      statusText: response.statusText,
      message: errorMsg,
      rawBody,
    })
  }
  return errorMsg
}

export const API_TIMEOUT_ERROR_NAME = 'ApiTimeoutError'

/**
 * 客户端按配置的「超时时间」主动中止请求时使用的清晰错误。
 * 直接 controller.abort() 会让 fetch 抛出「signal is aborted without reason」的 AbortError，
 * 既看不出是超时，也会被错误归类为网络异常；这里用带原因的错误替代。
 */
export function createApiTimeoutError(timeoutSec: number): Error {
  const err = new Error(`请求超时：${timeoutSec} 秒内未收到上游响应（上游处理过慢，或被反向代理/CDN 断开）`)
  err.name = API_TIMEOUT_ERROR_NAME
  return err
}

export function isApiTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === API_TIMEOUT_ERROR_NAME
}

/**
 * 包装 fetch 并记录请求/响应日志（URL、方法、状态、耗时、超时/网络错误）。
 * 不读取响应体（交由调用方处理），不记录请求头（避免泄露凭据）。
 * meta 仅传入安全摘要字段；即便误传 base64/密钥，logger 也会脱敏截断。
 */
export async function loggedFetch(
  context: string,
  url: string,
  init: RequestInit,
  meta?: Record<string, unknown>,
): Promise<Response> {
  const startedAt = Date.now()
  logger.info('api', `→ ${context}`, { url, method: init.method ?? 'GET', ...meta })
  try {
    const response = await fetch(url, init)
    const elapsedMs = Date.now() - startedAt
    const detail = { url, status: response.status, statusText: response.statusText, elapsedMs }
    if (response.ok) logger.info('api', `← ${context} ${response.status}`, detail)
    else logger.warn('api', `← ${context} ${response.status}`, detail)
    return response
  } catch (err) {
    const label = isApiTimeoutError(err) ? '请求超时' : '网络/请求异常'
    logger.error('api', `✗ ${context} ${label}`, { url, elapsedMs: Date.now() - startedAt, error: serializeError(err) })
    throw err
  }
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high') {
    actualParams.quality = record.quality
  }
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}
