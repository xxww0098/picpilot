import { describe, expect, it } from 'vitest'
import {
  getApiModeLabel,
  getAppModeLabel,
  getErrorTypeLabel,
  getEventActionLabel,
  getEventTypeLabel,
  getHttpStatusLabel,
  getParamValueLabel,
  getProviderDisplayName,
  getUserFacingErrorMessage,
} from './userFacingText'

describe('userFacingText', () => {
  it('translates internal status fields', () => {
    expect(getEventTypeLabel('success')).toBe('成功')
    expect(getEventActionLabel('regenerate_image')).toBe('单张重新生成')
    expect(getEventActionLabel('agent_message')).toBe('Agent 对话')
    expect(getAppModeLabel('video')).toBe('Video')
    expect(getErrorTypeLabel('rate_limit')).toBe('额度或限流')
    expect(getApiModeLabel('videos')).toBe('Videos API（视频接口）')
    expect(getApiModeLabel('responses')).toBe('Responses API（对话接口）')
    expect(getProviderDisplayName('openai')).toBe('OpenAI 兼容')
    expect(getHttpStatusLabel(429)).toBe('429 额度或频率限制')
    expect(getParamValueLabel('quality', 'high')).toBe('高')
    expect(getParamValueLabel('moderation', 'low')).toBe('低强度')
  })

  it('turns network errors into actionable messages', () => {
    expect(getUserFacingErrorMessage(new TypeError('Failed to fetch'))).toContain('网络请求失败')
  })

  it('preserves server error messages', () => {
    const message = '服务繁忙，当前 5 个请求在处理中，请几秒后重试。'
    expect(getUserFacingErrorMessage(message)).toBe(message)
  })

  it('maps Cloudflare challenge pages to a clear gateway message even when they embed 401/403', () => {
    const cfHtml =
      '<html><head><title>Just a moment...</title></head><body>error 401 <script>window._cf_chl_opt={}</script> cdn-cgi/challenge-platform</body></html>'
    // Agent path: no apiUpstream flag, body contains "401" — must NOT become an auth-key error.
    const out = getUserFacingErrorMessage(cfHtml)
    expect(out).toContain('Cloudflare')
    expect(out).not.toContain('API_PROXY_API_KEY')
  })

  it('maps Cloudflare block pages from the upstream proxy path too', () => {
    const blocked = 'Attention Required! | Cloudflare — Sorry, you have been blocked'
    expect(getUserFacingErrorMessage(blocked, '操作失败', { apiUpstream: true })).toContain('Cloudflare')
  })

  it('preserves CPA reverse-import errors instead of mapping them to API key auth failures', () => {
    const message = 'CPA 管理令牌无效：请填写 config.yaml 中 remote-management.secret-key 的明文值，不是 sk- 开头的出图 API Key。'
    expect(getUserFacingErrorMessage(message)).toBe(message)
    expect(getUserFacingErrorMessage(message)).not.toContain('API_PROXY_API_KEY')
  })
})
