import type { ApiMode, ApiProfile } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { isApiTimeoutError } from './imageApiShared'
import { getApiModeLabel } from './userFacingText'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'

export type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

export function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

export function isFalConnectionRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiModeApiName(apiMode: ApiMode) {
  return getApiModeLabel(apiMode)
}

export function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? `\n· API 不支持 ${getApiModeApiName(profile.apiMode)}`
      : ''
    return `提示：请求立即失败，可能原因：\n· API 服务器不可达或地址有误，请检查 API 基础地址是否正确、服务是否正常运行${unsupportedApiHint}\n· 接口不支持浏览器跨域请求，可使用 Docker 部署版或本地运行版并配置 API 代理解决`
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 60 秒后被断开，这通常是反向代理的默认超时，而非接口本身报错。可调大代理的超时时间，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${getTimeoutStreamingHint(profile)}`
  }

  return `提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
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

  return `提示：接口返回鉴权失败（未提供有效凭据）。请检查：\n· 当前 API 与模型配置中的 API Key 是否已正确填写且未过期\n· API 基础地址是否指向正确的服务地址${logHint}`
}
