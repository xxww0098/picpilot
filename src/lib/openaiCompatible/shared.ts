import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type CustomProviderDefinition, type ImageApiResponse } from '../../types'
import { getStoredAuthToken } from '../auth'
import { explicitUpstreamModeHeader } from '../apiProfiles'
import type { CallApiResult } from '../imageApiShared'

export const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

export function getStreamPartialImages(profile: ApiProfile): number {
  return profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
}

/** 从并发批量结果中收集失败槽位的数量与原因（每个 settled 结果对应一张图的请求）。 */
export function collectConcurrentFailures(results: PromiseSettledResult<CallApiResult>[]): { failedCount?: number; failedErrors?: string[] } {
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (!rejected.length) return {}
  return {
    failedCount: rejected.length,
    failedErrors: rejected.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason))),
  }
}

export function appendQuery(path: string, query?: Record<string, string>): string {
  if (!query || !Object.keys(query).length) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

export function createOpenAICompatiblePaths(_customProvider?: CustomProviderDefinition | null) {
  return {
    generationPath: 'images/generations',
    editPath: 'images/edits',
  }
}

export function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

export function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  const parts = path.split('.').filter(Boolean)
  let current: unknown[] = [source]

  for (const key of parts) {
    const next: unknown[] = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
        continue
      }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }

  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

export function normalizeImageApiPayload(value: unknown): ImageApiResponse {
  if (Array.isArray(value)) return { data: value as ImageApiResponse['data'] }
  if (value && typeof value === 'object') return value as ImageApiResponse
  return { data: [] }
}

export function createRequestHeaders(profile: ApiProfile, options: { includeAppAuth?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  const apiKey = profile.apiKey.trim()
  if (!options.includeAppAuth && apiKey) headers.Authorization = `Bearer ${apiKey}`

  if (options.includeAppAuth) {
    const upstreamMode = explicitUpstreamModeHeader(profile.upstreamMode)
    if (upstreamMode) headers['X-PicPilot-Upstream-Mode'] = upstreamMode
    const token = getStoredAuthToken()
    if (token) headers['X-PicPilot-Authorization'] = `Bearer ${token}`
  }

  return headers
}

export function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? '流式请求失败'
  }
  return null
}

function parseServerSentEventBlock(block: string): { data: string; eventType?: string } | null {
  const dataLines: string[] = []
  let eventType: string | undefined
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      const value = line.slice(6).trim()
      if (value) eventType = value
      continue
    }
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return null
  return { data, eventType }
}

export async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void | Promise<void>): Promise<void> {
  if (!response.body) throw new Error('接口未返回可读取的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processBlock = async (block: string) => {
    const parsed = parseServerSentEventBlock(block)
    if (!parsed) return

    let event: unknown
    try {
      event = JSON.parse(parsed.data)
    } catch {
      throw new Error('流式响应包含无法解析的 JSON 事件')
    }
    if (!isRecordValue(event)) return
    const eventRecord = parsed.eventType && !getStringValue(event, 'type')
      ? { ...event, type: parsed.eventType }
      : event

    const errorMessage = getStreamEventErrorMessage(eventRecord)
    if (errorMessage) throw new Error(errorMessage)

    await onEvent(eventRecord)
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.search(/\r?\n\r?\n/)
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex)
      const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
      buffer = buffer.slice(separatorIndex + separator.length)
      await processBlock(block)
      separatorIndex = buffer.search(/\r?\n\r?\n/)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) await processBlock(buffer)
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}
