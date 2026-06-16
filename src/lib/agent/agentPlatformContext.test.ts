import { describe, expect, it } from 'vitest'
import type { AgentConversation, AgentRound, TaskRecord } from '../../types'
import { addTaskToAgentAssetPlan, buildAgentPlatformContextItem, getValidAgentTargetAssetSlotId, withAgentPlatformTaskMetadata } from './agentPlatformContext'

function conversation(patch: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: 'Ozon 项目',
    platformId: 'ozon',
    platformBrief: { productName: '保温杯', sellingPoints: ['保温 12 小时'] },
    assetPlan: [{ slotId: 'ozon_main', status: 'planned', taskIds: ['task-a'] }],
    activeRoundId: 'round-a',
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...patch,
  }
}

function round(patch: Partial<AgentRound> = {}): AgentRound {
  return {
    id: 'round-a',
    index: 1,
    parentRoundId: null,
    userMessageId: 'user-a',
    prompt: '生成主图',
    inputImageIds: [],
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    ...patch,
  }
}

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
    ...patch,
  }
}

describe('agent platform context', () => {
  it('builds invisible API context for a platform conversation', () => {
    const item = buildAgentPlatformContextItem(conversation(), round({ targetAssetSlotId: 'ozon_main' }), [task()])

    expect(item).toMatchObject({ role: 'user' })
    expect(JSON.stringify(item)).toContain('Platform: Ozon')
    expect(JSON.stringify(item)).toContain('保温杯')
    expect(JSON.stringify(item)).toContain('ozon_main')
  })

  it('returns null context for legacy conversations', () => {
    expect(buildAgentPlatformContextItem(conversation({ platformId: 'generic_legacy' }), round(), [])).toBeNull()
  })

  it('accepts only target slots from the current platform', () => {
    expect(getValidAgentTargetAssetSlotId('ozon', 'ozon_main')).toBe('ozon_main')
    expect(getValidAgentTargetAssetSlotId('ozon', 'site_hero')).toBeNull()
  })

  it('adds platform metadata to agent tasks', () => {
    expect(withAgentPlatformTaskMetadata(task(), conversation(), round({ targetAssetSlotId: 'ozon_main' }))).toMatchObject({
      platformId: 'ozon',
      platformAssetSlotId: 'ozon_main',
      assetStatus: 'candidate',
    })
  })

  it('preserves existing platform asset status on agent tasks', () => {
    expect(withAgentPlatformTaskMetadata(task({ assetStatus: 'approved' }), conversation(), round({ targetAssetSlotId: 'ozon_main' }))).toMatchObject({
      platformId: 'ozon',
      platformAssetSlotId: 'ozon_main',
      assetStatus: 'approved',
    })
  })

  it('does not mutate the original task when adding platform metadata', () => {
    const original = task()
    const updated = withAgentPlatformTaskMetadata(original, conversation(), round({ targetAssetSlotId: 'ozon_main' }))

    expect(updated).not.toBe(original)
    expect(original.platformId).toBeUndefined()
    expect(original.platformAssetSlotId).toBeUndefined()
    expect(original.assetStatus).toBeUndefined()
  })

  it('adds a task id to an existing asset plan slot once and marks it generating', () => {
    const existing = conversation().assetPlan

    const updated = addTaskToAgentAssetPlan(existing, 'ozon_main', 'task-b')
    const duplicated = addTaskToAgentAssetPlan(updated, 'ozon_main', 'task-b')

    expect(duplicated?.find((item) => item.slotId === 'ozon_main')).toMatchObject({
      status: 'generating',
      taskIds: ['task-a', 'task-b'],
    })
  })

  it('creates an asset plan item when attaching to a missing plan', () => {
    expect(addTaskToAgentAssetPlan(undefined, 'ozon_main', 'task-a')).toEqual([
      { slotId: 'ozon_main', status: 'generating', taskIds: ['task-a'] },
    ])
  })

  it('leaves the asset plan unchanged without a target slot', () => {
    const existing = conversation().assetPlan

    expect(addTaskToAgentAssetPlan(existing, null, 'task-b')).toBe(existing)
  })
})
