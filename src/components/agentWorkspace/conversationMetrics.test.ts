import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type AgentConversation, type TaskRecord } from '../../types'
import { getConversationAssetPlanProgress } from './conversationMetrics'

function conversation(patch: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: 'Ozon 项目',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    platformId: 'ozon',
    assetPlan: [
      { slotId: 'ozon_main', status: 'planned', taskIds: [] },
      { slotId: 'ozon_gallery', status: 'planned', taskIds: [] },
      { slotId: 'ozon_infographic', status: 'planned', taskIds: [] },
      { slotId: 'ozon_rich_content', status: 'planned', taskIds: [] },
    ],
    ...patch,
  }
}

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: ['image-a'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  }
}

describe('conversationMetrics', () => {
  it('counts asset slots filled by matching platform task metadata', () => {
    const progress = getConversationAssetPlanProgress(conversation(), [
      task({
        id: 'task-from-metadata',
        agentConversationId: 'conversation-a',
        platformId: 'ozon',
        platformAssetSlotId: 'ozon_main',
      }),
    ])

    expect(progress).toBe('1/4 槽位')
  })

  it('does not count stale asset plan task ids without a remaining completed task', () => {
    const progress = getConversationAssetPlanProgress(conversation({
      assetPlan: [
        { slotId: 'ozon_main', status: 'ready', taskIds: ['deleted-task'], approvedTaskId: 'deleted-task' },
        { slotId: 'ozon_gallery', status: 'planned', taskIds: [] },
        { slotId: 'ozon_infographic', status: 'planned', taskIds: [] },
        { slotId: 'ozon_rich_content', status: 'planned', taskIds: [] },
      ],
    }), [])

    expect(progress).toBe('0/4 槽位')
  })
})
