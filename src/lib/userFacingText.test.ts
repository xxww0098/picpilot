import { describe, expect, it } from 'vitest'
import {
  getApiModeLabel,
  getErrorTypeLabel,
  getEventTypeLabel,
  getHttpStatusLabel,
  getParamValueLabel,
  getProviderDisplayName,
  getUserFacingErrorMessage,
} from './userFacingText'

describe('userFacingText', () => {
  it('translates internal status fields', () => {
    expect(getEventTypeLabel('success')).toBe('成功')
    expect(getErrorTypeLabel('rate_limit')).toBe('额度或限流')
    expect(getApiModeLabel('responses')).toBe('Responses API（对话接口）')
    expect(getProviderDisplayName('openai')).toBe('OpenAI 兼容')
    expect(getHttpStatusLabel(429)).toBe('429 额度或频率限制')
    expect(getParamValueLabel('quality', 'high')).toBe('高')
    expect(getParamValueLabel('moderation', 'low')).toBe('低强度')
  })

  it('turns network errors into actionable messages', () => {
    expect(getUserFacingErrorMessage(new TypeError('Failed to fetch'))).toContain('网络请求失败')
  })

  it('preserves quota messages from the server', () => {
    const message = '团队服务小时额度已用完：过去 1 小时成功 100/100 张'
    expect(getUserFacingErrorMessage(message)).toBe(message)
  })
})
