import { describe, expect, it } from 'vitest'
import { normalizeAgentConversations, getPersistableAgentConversation } from './agentPersistence'
import type { AgentConversation } from '../types'

function baseConversation(patch: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: '新对话',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...patch,
  }
}

describe('agent platform persistence', () => {
  it('normalizes old conversations to generic_legacy without losing content', () => {
    const [conversation] = normalizeAgentConversations([
      baseConversation({
        title: '旧对话',
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          prompt: '旧主图',
          inputImageIds: [],
          outputTaskIds: [],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
        messages: [
          {
            id: 'user-a',
            role: 'user',
            content: '生成旧主图',
            roundId: 'round-a',
            createdAt: 1,
          },
          {
            id: 'assistant-a',
            role: 'assistant',
            content: '已完成',
            roundId: 'round-a',
            createdAt: 2,
          },
        ],
      }),
    ])

    expect(conversation.platformId).toBe('generic_legacy')
    expect(conversation.title).toBe('旧对话')
    expect(conversation.rounds).toHaveLength(1)
    expect(conversation.rounds[0]).toMatchObject({
      id: 'round-a',
      userMessageId: 'user-a',
      assistantMessageId: 'assistant-a',
      prompt: '旧主图',
      status: 'done',
    })
    expect(conversation.messages).toHaveLength(2)
    expect(conversation.messages.map((message) => message.id)).toEqual(['user-a', 'assistant-a'])
  })

  it('preserves platform brief and asset plan for new conversations', () => {
    const [conversation] = normalizeAgentConversations([
      baseConversation({
        platformId: 'ozon',
        platformBrief: {
          productName: '保温杯',
          sellingPoints: ['316 不锈钢', '长效保温'],
          restrictions: ['不要联系方式'],
        },
        assetPlan: [{
          slotId: 'ozon_main',
          status: 'ready',
          taskIds: ['task-a'],
          approvedTaskId: 'task-a',
          notes: '主图候选',
        }],
      }),
    ])

    expect(conversation.platformId).toBe('ozon')
    expect(conversation.platformBrief?.productName).toBe('保温杯')
    expect(conversation.platformBrief?.sellingPoints).toEqual(['316 不锈钢', '长效保温'])
    expect(conversation.platformBrief?.restrictions).toEqual(['不要联系方式'])
    expect(conversation.assetPlan?.[0]).toMatchObject({
      slotId: 'ozon_main',
      status: 'ready',
      taskIds: ['task-a'],
      approvedTaskId: 'task-a',
      notes: '主图候选',
    })
  })

  it('normalizes invalid platform fields and invalid asset plan items', () => {
    const [conversation] = normalizeAgentConversations([
      {
        ...baseConversation(),
        platformId: 'bad-platform',
        platformBrief: { productName: 123, sellingPoints: ['ok', 123] },
        assetPlan: [
          { slotId: 'slot-a', status: 'bad', taskIds: ['task-a', 123] },
          { slotId: '', status: 'bad', taskIds: [] },
        ],
      },
    ])

    expect(conversation.platformId).toBe('generic_legacy')
    expect(conversation.platformBrief).toEqual({ sellingPoints: ['ok'] })
    expect(conversation.assetPlan).toEqual([{ slotId: 'slot-a', status: 'planned', taskIds: ['task-a'] }])
  })

  it('keeps platform fields in persistable conversations', () => {
    const persistable = getPersistableAgentConversation(baseConversation({
      platformId: 'independent_site',
      platformBrief: { productName: '手工灯' },
      assetPlan: [{ slotId: 'site_hero', status: 'planned', taskIds: [] }],
    }))

    expect(persistable.platformId).toBe('independent_site')
    expect(persistable.platformBrief?.productName).toBe('手工灯')
    expect(persistable.assetPlan?.[0]?.slotId).toBe('site_hero')
  })
})
