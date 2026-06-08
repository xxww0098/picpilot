import path from 'path'
import { open, readFile, stat } from 'fs/promises'

export interface UpstreamAccountHealthRow {
  accountKey: string
  label: string
  provider: string
  total: number
  success: number
  failure: number
  failureRate: number
  avgDurationMs: number | null
  lastSeenAt: number | null
  models: string[]
  routes: Array<{ route: string; total: number; failure: number }>
  status: 'healthy' | 'watch' | 'isolate'
  recommendation: string
}

export interface UpstreamHealthReport {
  available: boolean
  logDir: string | null
  message?: string
  scannedBytes: number
  generatedAt: number
  accounts: UpstreamAccountHealthRow[]
}

interface AccountAccumulator {
  accountKey: string
  label: string
  provider: string
  total: number
  success: number
  failure: number
  durationMs: number
  durationSamples: number
  lastSeenAt: number | null
  models: Set<string>
  routes: Map<string, { total: number; failure: number }>
}

interface RoutedRequest {
  accountKey: string
  route?: string
}

const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024

function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function maskAuthFile(provider: string, authFile: string): { key: string; label: string } {
  const base = path.basename(authFile).replace(/\.json$/i, '')
  const key = `${provider}:${hashString(base)}`
  return { key, label: `${provider}:${key.slice(-8)}` }
}

function parseLogTimestamp(value: string): number | null {
  const ts = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(ts) ? ts : null
}

function parseDurationMs(raw: string): number | null {
  const value = raw.trim()
  if (!value) return null
  let total = 0
  let matched = false
  const pattern = /(\d+(?:\.\d+)?)\s*(us|µs|ms|s|m)/gi
  for (const match of value.matchAll(pattern)) {
    matched = true
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    if (!Number.isFinite(amount)) continue
    if (unit === 'm') total += amount * 60_000
    else if (unit === 's') total += amount * 1000
    else if (unit === 'ms') total += amount
    else total += amount / 1000
  }
  return matched ? Math.max(0, total) : null
}

async function readTail(filePath: string, maxBytes = MAX_LOG_TAIL_BYTES): Promise<{ text: string; bytes: number }> {
  const info = await stat(filePath)
  const start = Math.max(0, info.size - maxBytes)
  const length = info.size - start
  const buffer = Buffer.alloc(length)
  const file = await open(filePath, 'r')
  try {
    await file.read(buffer, 0, length, start)
  } finally {
    await file.close()
  }
  return { text: buffer.toString('utf8'), bytes: length }
}

function getAccount(
  accounts: Map<string, AccountAccumulator>,
  provider: string,
  authFile: string,
): AccountAccumulator {
  const masked = maskAuthFile(provider, authFile)
  const existing = accounts.get(masked.key)
  if (existing) return existing
  const account: AccountAccumulator = {
    accountKey: masked.key,
    label: masked.label,
    provider,
    total: 0,
    success: 0,
    failure: 0,
    durationMs: 0,
    durationSamples: 0,
    lastSeenAt: null,
    models: new Set(),
    routes: new Map(),
  }
  accounts.set(masked.key, account)
  return account
}

function recordRoute(account: AccountAccumulator, route: string, failed: boolean) {
  const current = account.routes.get(route) ?? { total: 0, failure: 0 }
  current.total++
  if (failed) current.failure++
  account.routes.set(route, current)
}

function finalizeAccount(account: AccountAccumulator): UpstreamAccountHealthRow {
  const failureRate = account.total > 0 ? account.failure / account.total : 0
  let status: UpstreamAccountHealthRow['status'] = 'healthy'
  let recommendation = '继续观察。'
  if (account.failure >= 3 && failureRate >= 0.5) {
    status = 'isolate'
    recommendation = '建议临时隔离该账号，检查 OAuth 登录态或上游额度后再恢复。'
  } else if (account.failure >= 2 && failureRate >= 0.25) {
    status = 'watch'
    recommendation = '建议降低该账号承载或重点观察最近错误。'
  }

  return {
    accountKey: account.accountKey,
    label: account.label,
    provider: account.provider,
    total: account.total,
    success: account.success,
    failure: account.failure,
    failureRate,
    avgDurationMs: account.durationSamples > 0 ? account.durationMs / account.durationSamples : null,
    lastSeenAt: account.lastSeenAt,
    models: Array.from(account.models).sort(),
    routes: Array.from(account.routes.entries())
      .map(([route, stats]) => ({ route, ...stats }))
      .sort((a, b) => b.failure - a.failure || b.total - a.total || a.route.localeCompare(b.route)),
    status,
    recommendation,
  }
}

export async function getUpstreamHealthReport(logDir: string): Promise<UpstreamHealthReport> {
  const trimmed = logDir.trim()
  if (!trimmed) {
    return {
      available: false,
      logDir: null,
      message: '未配置 CLIPROXY_LOG_DIR，无法读取 CLIProxy 账号路由日志。',
      scannedBytes: 0,
      generatedAt: Date.now(),
      accounts: [],
    }
  }

  const mainLog = path.resolve(trimmed, 'main.log')
  let text = ''
  let scannedBytes = 0
  try {
    const tail = await readTail(mainLog)
    text = tail.text
    scannedBytes = tail.bytes
  } catch (err) {
    return {
      available: false,
      logDir: trimmed,
      message: `无法读取 ${mainLog}：${err instanceof Error ? err.message : String(err)}`,
      scannedBytes: 0,
      generatedAt: Date.now(),
      accounts: [],
    }
  }

  const accounts = new Map<string, AccountAccumulator>()
  const routedRequests = new Map<string, RoutedRequest>()
  for (const line of text.split(/\r?\n/)) {
    const routeMatch = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\].*Use OAuth provider=([^\s]+)\s+auth_file=([^\s]+)\s+for model\s+(.+)$/)
    if (routeMatch) {
      const [, timestamp, requestId, provider, authFile, model] = routeMatch
      const account = getAccount(accounts, provider, authFile)
      const seenAt = parseLogTimestamp(timestamp)
      if (seenAt != null) account.lastSeenAt = Math.max(account.lastSeenAt ?? 0, seenAt)
      if (model.trim()) account.models.add(model.trim())
      routedRequests.set(requestId, { accountKey: account.accountKey })
      continue
    }

    const statusMatch = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\].*?\]\s+(\d{3})\s+\|\s*([^|]+?)\s*\|\s*[^|]*\|\s*([A-Z]+)\s+"([^"]+)"/)
    if (!statusMatch) continue

    const [, timestamp, requestId, statusRaw, durationRaw, method, route] = statusMatch
    const routed = routedRequests.get(requestId)
    if (!routed) continue
    const account = accounts.get(routed.accountKey)
    if (!account) continue

    const status = Number(statusRaw)
    const failed = Number.isFinite(status) && status >= 400
    const seenAt = parseLogTimestamp(timestamp)
    if (seenAt != null) account.lastSeenAt = Math.max(account.lastSeenAt ?? 0, seenAt)
    const durationMs = parseDurationMs(durationRaw)
    if (durationMs != null) {
      account.durationMs += durationMs
      account.durationSamples++
    }
    account.total++
    if (failed) account.failure++
    else account.success++
    recordRoute(account, `${method} ${route}`, failed)
  }

  return {
    available: true,
    logDir: trimmed,
    scannedBytes,
    generatedAt: Date.now(),
    accounts: Array.from(accounts.values())
      .map(finalizeAccount)
      .sort((a, b) => {
        const statusRank = { isolate: 0, watch: 1, healthy: 2 }
        return statusRank[a.status] - statusRank[b.status] || b.failure - a.failure || b.total - a.total
      }),
  }
}

export async function readRecentLogNames(logDir: string, limit = 20): Promise<string[]> {
  const trimmed = logDir.trim()
  if (!trimmed) return []
  const { readdir } = await import('fs/promises')
  try {
    const entries = await readdir(trimmed)
    return entries
      .filter((name) => /^error-.*\.log$/i.test(name))
      .sort()
      .slice(-limit)
  } catch {
    return []
  }
}

export async function readSmallTextFile(filePath: string, maxBytes = 64 * 1024): Promise<string | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null
    const text = await readFile(filePath, 'utf8')
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  } catch {
    return null
  }
}
