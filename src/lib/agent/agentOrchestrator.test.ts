import { describe, expect, it } from 'vitest'
import { shouldRunAgentNoImageFallback } from './agentNoImageFallback'
import { resolveAgentTaskPrompt } from './agentOrchestrator'

describe('resolveAgentTaskPrompt', () => {
  it('falls back to the round prompt when a streamed image tool starts without its own prompt', () => {
    expect(resolveAgentTaskPrompt('', 'Create a product hero image', 'User message')).toBe('Create a product hero image')
  })

  it('keeps the image tool prompt when it is provided', () => {
    expect(resolveAgentTaskPrompt('Make it blue', 'Create a product hero image', 'User message')).toBe('Make it blue')
  })
})

describe('shouldRunAgentNoImageFallback', () => {
  it('forces an image fallback when the user explicitly asked for a new image but the Agent only returned text', () => {
    expect(shouldRunAgentNoImageFallback({
      prompt: '第 9 轮：基于上一张图修改，背景从浅灰改为非常淡的暖灰，杯子仍为白色陶瓷。只生成 1 张新图。',
      outputTaskCount: 0,
      outputImageCount: 0,
      responseOutput: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '已生成 1 张新图。' }],
        },
      ],
    })).toBe(true)
  })

  it('does not fall back when an image task already exists', () => {
    expect(shouldRunAgentNoImageFallback({
      prompt: '生成一张白色陶瓷咖啡杯商品图。',
      outputTaskCount: 1,
      outputImageCount: 1,
      responseOutput: [],
    })).toBe(false)
  })

  it('does not turn text-only critique into image generation', () => {
    expect(shouldRunAgentNoImageFallback({
      prompt: '这张商品图哪里可以优化？请给我文字建议。',
      outputTaskCount: 0,
      outputImageCount: 0,
      responseOutput: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '可以优化光线和构图。' }],
        },
      ],
    })).toBe(false)
  })
})
