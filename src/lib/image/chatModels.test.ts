import { describe, expect, it } from 'vitest'
import {
  CHAT_MODELS,
  DEFAULT_AGENT_MODEL,
  chatModelSupportsHostedImageTool,
  getAgentImageEngine,
  getChatModelLabel,
  isKnownChatModel,
} from './chatModels'

describe('chatModels', () => {
  it('提供 gpt-5.5 与 grok-4.3，默认 gpt-5.5', () => {
    const ids = CHAT_MODELS.map((model) => model.id)
    expect(ids).toContain('gpt-5.5')
    expect(ids).toContain('grok-4.3')
    expect(DEFAULT_AGENT_MODEL).toBe('gpt-5.5')
  })

  it('仅 gpt 系支持托管 image_generation 工具；grok 不支持', () => {
    expect(chatModelSupportsHostedImageTool('gpt-5.5')).toBe(true)
    expect(chatModelSupportsHostedImageTool('grok-4.3')).toBe(false)
  })

  it('未知（自定义）模型默认按支持托管工具处理，保持既有行为', () => {
    expect(chatModelSupportsHostedImageTool('some-custom-chat-model')).toBe(true)
  })

  it('非托管模型(grok)出图引擎为 grok-imagine-image', () => {
    expect(getAgentImageEngine('grok-4.3')).toBe('grok-imagine-image')
  })

  it('getChatModelLabel / isKnownChatModel 行为正确', () => {
    expect(getChatModelLabel('grok-4.3')).toBe('Grok 4.3')
    expect(getChatModelLabel('x')).toBe('x')
    expect(isKnownChatModel('gpt-5.5')).toBe(true)
    expect(isKnownChatModel('x')).toBe(false)
  })
})
