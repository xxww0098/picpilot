import { authFetch } from './auth'
import { logger, serializeError } from './logger'
import { getUserFacingErrorMessage } from './userFacingText'

export async function readErrorMessage(res: Response, fallback = '请求失败'): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return getUserFacingErrorMessage(fallback, fallback, res.status)

  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown }
    const message = typeof data.error === 'string'
      ? data.error
      : typeof data.message === 'string'
        ? data.message
        : fallback
    return getUserFacingErrorMessage(message, fallback, res.status)
  } catch {
    return getUserFacingErrorMessage(text, fallback, res.status)
  }
}

export async function readJson<T>(res: Response, fallback = '请求失败'): Promise<T> {
  if (!res.ok) {
    const msg = await readErrorMessage(res, fallback)
    logger.warn('api', `readJson: HTTP ${res.status}`, { status: res.status, message: msg })
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function authJson<T>(input: RequestInfo | URL, init?: RequestInit, fallback = '请求失败'): Promise<T> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? 'GET'
  const startedAt = Date.now()
  try {
    const res = await authFetch(input, init)
    const result = await readJson<T>(res, fallback)
    logger.debug('api', `← ${method} ${url} ${res.status}`, { elapsedMs: Date.now() - startedAt })
    return result
  } catch (err) {
    logger.error('api', `✗ ${method} ${url}`, { elapsedMs: Date.now() - startedAt, error: serializeError(err) })
    throw err
  }
}
