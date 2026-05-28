/**
 * 轻量级运行日志系统。
 *
 * - 内存环形缓冲（保留最近 MAX_ENTRIES 条），刷新页面后清空。
 * - 同时镜像到浏览器控制台，便于开发者在 DevTools 查看。
 * - 写入前统一脱敏（API Key / Authorization / Bearer token 等）并截断超长字符串、
 *   base64 data URL，避免日志膨胀或泄露凭据。
 * - 通过 subscribe 暴露给应用内「运行日志」面板（配合 useSyncExternalStore）。
 *
 * 本模块不依赖任何 DOM API（除 console），可安全用于任意层。文件下载等 UI 行为放在面板组件中。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  /** 自增序号，作为 React key */
  id: number
  /** 记录时间（Date.now()） */
  time: number
  level: LogLevel
  /** 来源域，例如 'api' | 'task' | 'db' | 'global' */
  scope: string
  message: string
  /** 附加结构化数据，已脱敏 + 截断，JSON 安全 */
  data?: unknown
}

const MAX_ENTRIES = 1000
const MAX_STRING_CHARS = 2000
const DATA_URL_PREVIEW_CHARS = 48
const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_DEPTH = 6

/** 命中即视为敏感字段名，值整体替换为 *** */
const SECRET_KEY_PATTERN = /authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|cookie/i
/** 字符串中的 Bearer token 脱敏 */
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._\-]+/gi
/** sk- 开头的常见密钥脱敏 */
const SK_KEY_PATTERN = /\b(sk-[A-Za-z0-9]{3})[A-Za-z0-9._\-]{6,}/g

let seq = 0
const entries: LogEntry[] = []
const listeners = new Set<() => void>()
// useSyncExternalStore 要求快照引用在两次通知之间保持稳定，因此单独维护。
let snapshot: readonly LogEntry[] = []

function redactString(value: string): string {
  if (value.startsWith('data:') && value.length > DATA_URL_PREVIEW_CHARS) {
    return `${value.slice(0, DATA_URL_PREVIEW_CHARS)}…[data URL, ${value.length} chars]`
  }
  let out = value.replace(BEARER_PATTERN, '$1***').replace(SK_KEY_PATTERN, '$1***')
  if (out.length > MAX_STRING_CHARS) {
    out = `${out.slice(0, MAX_STRING_CHARS)}…[truncated, ${value.length} chars total]`
  }
  return out
}

function summarizeBlob(value: Blob): string {
  const name = value instanceof File ? `${value.name} ` : ''
  return `[Blob ${name}${value.type || 'application/octet-stream'} ${value.size}B]`
}

function summarizeFormData(value: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of value.entries()) {
    if (typeof item !== 'string') {
      out[key] = summarizeBlob(item)
    } else if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '***'
    } else {
      out[key] = redactString(item)
    }
  }
  return out
}

/** 把任意值转成 JSON 安全、已脱敏、已截断的可记录值。 */
function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string') return redactString(value as string)
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return `${(value as bigint).toString()}n`
  if (type === 'symbol') return (value as symbol).toString()
  if (type === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`

  if (value instanceof Error) return serializeError(value)
  if (typeof Blob !== 'undefined' && value instanceof Blob) return summarizeBlob(value)
  if (typeof FormData !== 'undefined' && value instanceof FormData) return summarizeFormData(value)
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}B]`
  if (ArrayBuffer.isView(value)) return `[${(value as object).constructor?.name ?? 'TypedArray'} ${(value as ArrayBufferView).byteLength}B]`

  if (depth >= MAX_OBJECT_DEPTH) return '[depth limit]'

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen))
    if (value.length > MAX_ARRAY_ITEMS) result.push(`…[${value.length - MAX_ARRAY_ITEMS} more items]`)
    seen.delete(value)
    return result
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>
    if (seen.has(obj)) return '[Circular]'
    seen.add(obj)
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(obj)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? '***' : sanitize(item, depth + 1, seen)
    }
    seen.delete(obj)
    return result
  }

  return String(value)
}

/** 把 Error（含自定义附加字段，如 rawResponsePayload）转为可记录对象。 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const result: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    if (err.stack) result.stack = redactString(err.stack)
    const extra = err as unknown as Record<string, unknown>
    for (const key of Object.keys(err)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue
      result[key] = sanitize(extra[key], 1)
    }
    return result
  }
  if (typeof err === 'string') return { message: redactString(err) }
  return { message: safeStringify(sanitize(err)) }
}

function safeStringify(value: unknown, space = 0): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value)
  } catch {
    return String(value)
  }
}

function consoleMethod(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'debug':
      return console.debug?.bind(console) ?? console.log.bind(console)
    case 'warn':
      return console.warn.bind(console)
    case 'error':
      return console.error.bind(console)
    default:
      return console.info?.bind(console) ?? console.log.bind(console)
  }
}

function mirrorToConsole(entry: LogEntry): void {
  const time = new Date(entry.time).toISOString().slice(11, 23)
  const label = `[${time}][${entry.scope}] ${entry.message}`
  const log = consoleMethod(entry.level)
  if (entry.data === undefined) log(label)
  else log(label, entry.data)
}

function notify(): void {
  snapshot = entries.slice()
  for (const listener of listeners) listener()
}

function record(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = {
    id: ++seq,
    time: Date.now(),
    level,
    scope,
    message,
    data: data === undefined ? undefined : sanitize(data),
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  mirrorToConsole(entry)
  notify()
}

export const logger = {
  debug: (scope: string, message: string, data?: unknown) => record('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) => record('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => record('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => record('error', scope, message, data),
}

/** 供 useSyncExternalStore 使用：稳定快照。 */
export function getLogEntries(): readonly LogEntry[] {
  return snapshot
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearLogs(): void {
  entries.length = 0
  notify()
}

export function formatLogEntryAsText(entry: LogEntry): string {
  const ts = new Date(entry.time).toISOString()
  const head = `${ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`
  if (entry.data === undefined) return head
  return `${head}\n${safeStringify(entry.data, 2)}`
}

export function formatLogsAsText(list: readonly LogEntry[] = snapshot): string {
  return list.map(formatLogEntryAsText).join('\n')
}
