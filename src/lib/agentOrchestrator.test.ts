import { describe, expect, it } from 'vitest'
import { resolveAgentTaskPrompt } from './agentOrchestrator'

describe('resolveAgentTaskPrompt', () => {
  it('falls back to the round prompt when a streamed image tool starts without its own prompt', () => {
    expect(resolveAgentTaskPrompt('', 'Create a product hero image', 'User message')).toBe('Create a product hero image')
  })

  it('keeps the image tool prompt when it is provided', () => {
    expect(resolveAgentTaskPrompt('Make it blue', 'Create a product hero image', 'User message')).toBe('Make it blue')
  })
})
