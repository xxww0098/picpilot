import { authFetch } from './auth'
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
  if (!res.ok) throw new Error(await readErrorMessage(res, fallback))
  return res.json() as Promise<T>
}

export async function authJson<T>(input: RequestInfo | URL, init?: RequestInit, fallback = '请求失败'): Promise<T> {
  return readJson<T>(await authFetch(input, init), fallback)
}
