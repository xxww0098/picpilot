// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AgentConversation, type TaskRecord } from '../../types'
import AgentAssetPlanPanel from './AgentAssetPlanPanel'

afterEach(() => {
  cleanup()
})

function conversation(): AgentConversation {
  return {
    id: 'conversation-a',
    title: 'Ozon 项目',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    platformId: 'ozon',
    assetPlan: [{ slotId: 'ozon_main', status: 'planned', taskIds: ['running-task', 'error-task', 'empty-task', 'done-task'] }],
  }
}

function task(patch: Partial<TaskRecord>): TaskRecord {
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
    platformId: 'ozon',
    platformAssetSlotId: 'ozon_main',
    agentConversationId: 'conversation-a',
    ...patch,
  }
}

describe('AgentAssetPlanPanel', () => {
  it('disables approval for running, error, and zero-output tasks', () => {
    const onSetTaskAssetStatus = vi.fn()
    render(
      <AgentAssetPlanPanel
        conversation={conversation()}
        tasks={[
          task({ id: 'running-task', status: 'running', outputImages: ['running-image'], createdAt: 4 }),
          task({ id: 'error-task', status: 'error', outputImages: ['error-image'], createdAt: 3 }),
          task({ id: 'empty-task', status: 'done', outputImages: [], createdAt: 2 }),
          task({ id: 'done-task', status: 'done', outputImages: ['done-image'], createdAt: 1 }),
        ]}
        onSetTaskAssetStatus={onSetTaskAssetStatus}
      />,
    )

    const approveButtons = screen.getAllByRole('button', { name: '通过' }) as HTMLButtonElement[]
    expect(approveButtons.map((button) => button.disabled)).toEqual([true, true, true, false])

    approveButtons.forEach((button) => fireEvent.click(button))

    expect(onSetTaskAssetStatus).toHaveBeenCalledTimes(1)
    expect(onSetTaskAssetStatus).toHaveBeenCalledWith('done-task', 'approved')
  })
})
