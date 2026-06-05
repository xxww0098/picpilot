import { describe, expect, it } from 'vitest'
import {
  getApiModeLabel,
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

  it('preserves server error messages', () => {
    const message = '服务繁忙，当前 5 个请求在处理中，请几秒后重试。'
    expect(getUserFacingErrorMessage(message)).toBe(message)
  })
})
