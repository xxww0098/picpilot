import type { ApiProfile } from '../../types'
import { DEFAULT_SETTINGS } from '../shared/apiProfiles'
import { isApiTimeoutError } from '../image/imageApiShared'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'
const AGENT_RESPONSES_IDLE_HINT = 'Agent 长对话在长时间无流式输出时，易被反向代理按空闲连接断开；可开启流式传输，或请管理员将 Caddy/nginx read_timeout 与团队「请求超时」对齐（建议 ≥600 秒）。'

export type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: Partial<Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>> | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

function getAgentResponsesHint(profile?: Partial<Pick<ApiProfile, 'apiMode' | 'streamImages'>> | null) {
  if (profile?.apiMode === 'responses' && profile.streamImages !== true) {
    return ` ${AGENT_RESPONSES_IDLE_HINT}`
  }
  return ''
}

export function createOpenAITimeoutError(timeoutSeconds: number, profile?: Partial<Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>> | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

export function isRecoverableConnectionError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

/** Browser fetch failures, including Chrome/Edge `TypeError: network error` on dropped SSE streams. */
export function isFetchNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed|^network error$/i.test(message)
  }
  const message = err instanceof Error ? err.message : String(err)
  return /^network error$/i.test(message.trim())
}

function isApiRequestNetworkError(err: unknown): boolean {
  return isFetchNetworkError(err)
}

type NetworkHintProfile = Partial<Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages' | 'timeout'>> | null | undefined

export function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  _usesApiProxy: boolean,
  profile?: NetworkHintProfile,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)
  const roundedElapsedSeconds = Math.max(1, Math.round(elapsedSeconds))
  const streamHint = `${getTimeoutStreamingHint(profile)}${getAgentResponsesHint(profile)}`

  const configuredTimeout = profile?.timeout
  if (
    typeof configuredTimeout === 'number'
    && configuredTimeout >= 30
    && elapsedSeconds >= configuredTimeout - 25
    && elapsedSeconds <= configuredTimeout + 45
  ) {
    return `提示：请求等待约 ${roundedElapsedSeconds} 秒后被断开，耗时接近团队/配置中的请求超时（${configuredTimeout} 秒）。请在管理端「团队设置」调大请求超时，并确保 Caddy 等反向代理的 read_timeout 不小于该值。${streamHint}`
  }

  if (elapsedSeconds <= 15) {
    return '提示：请求立即失败，请联系管理员检查团队 API 代理服务是否正常运行。'
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 ${roundedElapsedSeconds} 秒后被断开，这通常是某一层反向代理的默认超时（约 60 秒），而非接口本身报错。请检查所有代理层的超时设置。${streamHint}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 ${roundedElapsedSeconds} 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制（约 100–120 秒），而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${streamHint}`
  }

  if (elapsedSeconds >= 165 && elapsedSeconds <= 210) {
    return `提示：请求等待约 ${roundedElapsedSeconds} 秒后被断开，常见于反向代理或团队「请求超时」设为约 180 秒，或长连接在 Agent/流式响应中长时间无数据被掐断。请把团队请求超时与 Caddy read_timeout 提高到 600 秒以上并重试。${streamHint}`
  }

  return `提示：请求等待约 ${roundedElapsedSeconds} 秒后被断开，通常是反向代理或网关的超时限制，或服务在部署/重启时断开连接。可检查代理超时设置和服务重启时间。${streamHint}`
}

export function getUpstreamApiErrorHint(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err)
  if (!message) return null

  if (isApiTimeoutError(err)) {
    return '提示：这是本应用按「超时时间」主动中止的请求，上游始终没有返回。图像编辑经 codex（gpt-image-2）通常很慢，可在「设置 → API 与模型」把超时时间调大；同时检查上游或反向代理/CDN 是否过慢或有更短的超时限制。'
  }

  if (/only supported on[^\n]*\/v1\/images/i.test(message)) {
    return '提示：该模型（如 gpt-image-2）只能通过 Images API（图像接口）调用。请在「设置 → API 与模型」中，把当前配置的接口模式从 Responses API（对话接口）改为 Images API（图像接口）后重试。'
  }
  if (/not supported on[^\n]*\/v1\/images/i.test(message)) {
    return '提示：当前配置的「模型 ID」不是上游支持的图像模型。请把模型改为上游支持的图像模型（上方错误信息中通常已列出可用模型，如 gpt-image-2 等），无需改动接口模式。'
  }

  const isAuthError = /auth_unavailable|no auth available|unauthorized|invalid[\s_-]*api[\s_-]*key|invalid authentication|api[\s_-]*key[^\n]*(invalid|expired|missing|required)|missing[^\n]*api[\s_-]*key|未授权|鉴权失败|认证失败|无效的?\s*api\s*key|\b401\b/i.test(message)
  if (!isAuthError) return null

  const logHint = '\n（可点开右上角「运行日志」查看该请求的原始响应内容）'
  const providerMatch = message.match(/providers?=([a-z0-9_.-]+(?:,[a-z0-9_.-]+)*)/i)
  if (/no auth available|auth_unavailable/i.test(message) && providerMatch) {
    const providerName = providerMatch[1]
    const codexNote = /codex/i.test(providerName)
      ? '（codex 即 ChatGPT 账号，gpt-image-2 正是由它提供，需在代理端完成 ChatGPT 登录）'
      : ''
    return `提示：上游代理（如 CLIProxyAPI）没有可用于「${providerName}」provider 的账号。${codexNote}请在代理端为该 provider 添加并登录账号，或改用你已配置账号的模型。${logHint}`
  }

  return `提示：上游接口返回鉴权失败。请联系管理员检查 API_PROXY_API_KEY 是否有效，或团队 API 代理是否指向了正确的上游地址。${logHint}`
}
