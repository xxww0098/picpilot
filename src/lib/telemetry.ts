import { AUTH_TOKEN_KEY } from './auth'
import type { AppMode } from '../types'

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

export type TelemetryEventType = 'success' | 'failure' | 'timeout' | 'cancelled'

export interface TelemetryEvent {
  event_type: TelemetryEventType
  app_mode?: AppMode
  provider?: string
  api_mode?: string
  model?: string
  size?: string
  quality?: string
  n_images?: number
  has_input_image?: boolean
  input_image_count?: number
  has_mask?: boolean
  prompt?: string
  action_type?: string
  task_id?: string
  image_index?: number
  duration_ms?: number
  http_status?: number
  error_type?: string
  error_message?: string
  error_stack?: string
  output_count?: number
  output_bytes?: number
  client_version?: string
}

export function classifyError(err: unknown): { error_type: string; http_status?: number } {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (lower.includes('超时') || lower.includes('timeout')) return { error_type: 'timeout' }
  if (lower.includes('中断') || lower.includes('abort') || lower.includes('cancel')) return { error_type: 'cancelled' }
  if (lower.includes('rate') && (lower.includes('limit') || lower.includes('429'))) return { error_type: 'rate_limit', http_status: 429 }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('未认证')) return { error_type: 'auth', http_status: 401 }
  if (lower.includes('403') || lower.includes('forbidden')) return { error_type: 'forbidden', http_status: 403 }
  if (lower.includes('400') || lower.includes('invalid') || lower.includes('bad request')) return { error_type: 'invalid_request', http_status: 400 }
  if (lower.includes('5') && (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504'))) return { error_type: 'server_error' }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('cors')) return { error_type: 'network' }
  return { error_type: 'unknown' }
}

export async function reportEvent(event: TelemetryEvent): Promise<void> {
  let token: string | null = null
  try {
    token = localStorage.getItem(AUTH_TOKEN_KEY)
  } catch {
    return
  }
  if (!token) return

  try {
    await fetch('/api/telemetry/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...event, client_version: event.client_version ?? APP_VERSION }),
      keepalive: true,
    })
  } catch {
    // 遥测失败不能影响主流程
  }
}
