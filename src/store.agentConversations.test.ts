import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './lib/shared/apiProfiles'
import { getSelectedImageMentionLabel } from './lib/ui/promptImageMentions'
vi.mock('./lib/shared/db', async () => (await import('./storeTestSetup')).createDbMock())
vi.mock('./lib/image/api', async () => (await import('./storeTestSetup')).createApiMock())
vi.mock('./lib/agent/agentApi', async () => (await import('./storeTestSetup')).createAgentApiMock())
import { clearTasks, getAllTasks, putTask as putDbTask } from './lib/shared/db'
import { cleanStaleAgentInputDrafts, deleteAgentRoundFromConversation, getActiveAgentRounds, getPersistedState, remapAgentRoundMentionsForPathChange, useStore } from './store'
import { agentConversation, imageA, imageB, task } from './storeTestSetup'

describe('agent conversation creation', () => {
  beforeEach(() => {
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      agentSidebarCollapsed: false,
      agentEditingRoundId: null,
    })
  })

  it('refreshes the latest empty conversation instead of creating another one', () => {
    const olderEmpty = agentConversation({ id: 'older-empty', createdAt: 1_000, updatedAt: 1_000 })
    const latestEmpty = agentConversation({ id: 'latest-empty', createdAt: 2_000, updatedAt: 2_000 })
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    useStore.setState({
      agentConversations: [olderEmpty, latestEmpty],
      activeAgentConversationId: olderEmpty.id,
      agentSidebarCollapsed: false,
      agentEditingRoundId: 'editing-round',
    })

    const id = useStore.getState().createAgentConversation()

    const state = useStore.getState()
    expect(id).toBe(latestEmpty.id)
    expect(state.activeAgentConversationId).toBe(latestEmpty.id)
    expect(state.agentConversations).toHaveLength(2)
    expect(state.agentConversations.find((item) => item.id === latestEmpty.id)).toMatchObject({
      createdAt: 3_000,
      updatedAt: 3_000,
    })
    expect(state.agentConversations.find((item) => item.id === olderEmpty.id)).toEqual(olderEmpty)
    expect(state.agentSidebarCollapsed).toBe(true)
    expect(state.agentEditingRoundId).toBeNull()
    now.mockRestore()
  })

  it('creates a new conversation when the latest conversation has messages', () => {
    const olderEmpty = agentConversation({ id: 'older-empty', createdAt: 1_000, updatedAt: 1_000 })
    const latestUsed = agentConversation({
      id: 'latest-used',
      activeRoundId: 'round-a',
      createdAt: 2_000,
      updatedAt: 2_000,
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 2_000,
        finishedAt: 2_000,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'prompt', roundId: 'round-a', createdAt: 2_000 }],
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    useStore.setState({ agentConversations: [olderEmpty, latestUsed], activeAgentConversationId: latestUsed.id })

    const id = useStore.getState().createAgentConversation()

    const state = useStore.getState()
    expect(id).not.toBe(olderEmpty.id)
    expect(id).not.toBe(latestUsed.id)
    expect(state.agentConversations).toHaveLength(3)
    expect(state.agentConversations[state.agentConversations.length - 1]).toMatchObject({ id, createdAt: 3_000, updatedAt: 3_000, messages: [], rounds: [] })
    expect(state.activeAgentConversationId).toBe(id)
    now.mockRestore()
  })

  it('creates a platform conversation when a platform id is provided', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000)
    useStore.setState({ agentConversations: [], activeAgentConversationId: null })

    const id = useStore.getState().createAgentConversation('ozon')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe(id)
    expect(state.agentConversations).toHaveLength(1)
    expect(state.agentConversations[0]).toMatchObject({
      id,
      platformId: 'ozon',
      assetPlan: [
        { slotId: 'ozon_main', status: 'planned', taskIds: [] },
        { slotId: 'ozon_gallery', status: 'planned', taskIds: [] },
        { slotId: 'ozon_infographic', status: 'planned', taskIds: [] },
        { slotId: 'ozon_rich_content', status: 'planned', taskIds: [] },
      ],
    })
    now.mockRestore()
  })

  it('does not reuse an empty conversation from a different platform', () => {
    const existing = agentConversation({ id: 'empty-ozon', platformId: 'ozon', createdAt: 1_000, updatedAt: 1_000 })
    useStore.setState({ agentConversations: [existing], activeAgentConversationId: existing.id })

    const id = useStore.getState().createAgentConversation('independent_site')

    const state = useStore.getState()
    expect(id).not.toBe(existing.id)
    expect(state.agentConversations).toHaveLength(2)
    expect(state.agentConversations.find((conversation) => conversation.id === id)?.platformId).toBe('independent_site')
  })
})

describe('agent platform task status', () => {
  it('marks an agent platform task as approved and rejects siblings in the same slot', () => {
    useStore.setState({
      tasks: [
        task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-b', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-c', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_gallery', assetStatus: 'candidate' }),
      ],
    })

    useStore.getState().setAgentTaskAssetStatus('task-b', 'approved')

    expect(useStore.getState().tasks.map((item) => [item.id, item.assetStatus])).toEqual([
      ['task-a', 'rejected'],
      ['task-b', 'approved'],
      ['task-c', 'candidate'],
    ])
  })

  it('rejects a previously approved sibling when approving another task in the same slot', () => {
    useStore.setState({
      tasks: [
        task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'approved' }),
        task({ id: 'task-b', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-c', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_gallery', assetStatus: 'approved' }),
      ],
    })

    useStore.getState().setAgentTaskAssetStatus('task-b', 'approved')

    expect(useStore.getState().tasks.map((item) => [item.id, item.assetStatus])).toEqual([
      ['task-a', 'rejected'],
      ['task-b', 'approved'],
      ['task-c', 'approved'],
    ])
  })

  it('persists approved target and rejected siblings to task storage', async () => {
    await clearTasks()
    const storedTasks = [
      task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'approved' }),
      task({ id: 'task-b', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
      task({ id: 'task-c', sourceMode: 'agent', agentConversationId: 'conversation-b', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'approved' }),
    ]
    for (const item of storedTasks) await putDbTask(item)
    useStore.setState({ tasks: storedTasks })

    useStore.getState().setAgentTaskAssetStatus('task-b', 'approved')

    await vi.waitFor(async () => {
      const persisted = await getAllTasks()
      expect(persisted.map((item) => [item.id, item.assetStatus])).toEqual([
        ['task-a', 'rejected'],
        ['task-b', 'approved'],
        ['task-c', 'approved'],
      ])
    })
  })

  it('does not reject same-platform same-slot candidates from another conversation', () => {
    useStore.setState({
      tasks: [
        task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-b', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-c', sourceMode: 'agent', agentConversationId: 'conversation-b', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
      ],
    })

    useStore.getState().setAgentTaskAssetStatus('task-b', 'approved')

    expect(useStore.getState().tasks.map((item) => [item.id, item.assetStatus])).toEqual([
      ['task-a', 'rejected'],
      ['task-b', 'approved'],
      ['task-c', 'candidate'],
    ])
  })

  it('does not reject siblings when setting a non-approved status', () => {
    useStore.setState({
      tasks: [
        task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-b', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
      ],
    })

    useStore.getState().setAgentTaskAssetStatus('task-b', 'rejected')

    expect(useStore.getState().tasks.map((item) => [item.id, item.assetStatus])).toEqual([
      ['task-a', 'candidate'],
      ['task-b', 'rejected'],
    ])
  })

  it('does nothing when the task id is missing', () => {
    const existing = task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' })
    useStore.setState({ tasks: [existing] })

    useStore.getState().setAgentTaskAssetStatus('missing-task', 'approved')

    expect(useStore.getState().tasks).toEqual([existing])
  })

  it('does nothing for a non-platform task id', () => {
    const existing = task({ id: 'task-a', sourceMode: 'gallery' })
    useStore.setState({ tasks: [existing] })

    useStore.getState().setAgentTaskAssetStatus('task-a', 'approved')

    expect(useStore.getState().tasks).toEqual([existing])
    expect(useStore.getState().tasks[0].assetStatus).toBeUndefined()
  })
})

describe('agent round deletion', () => {
  it('renumbers later rounds and remaps image mentions after deleting a middle round', () => {
    const conversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-1'],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          id: 'round-2',
          index: 2,
          parentRoundId: 'round-1',
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-2'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
        {
          id: 'round-3',
          index: 3,
          parentRoundId: 'round-2',
          userMessageId: 'user-3',
          assistantMessageId: 'assistant-3',
          prompt: '第三轮',
          inputImageIds: [],
          outputTaskIds: ['task-3'],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [
        { id: 'user-1', role: 'user', content: '第一轮', roundId: 'round-1', createdAt: 1 },
        { id: 'assistant-1', role: 'assistant', content: '完成', roundId: 'round-1', createdAt: 2 },
        { id: 'user-2', role: 'user', content: '第二轮', roundId: 'round-2', createdAt: 3 },
        { id: 'assistant-2', role: 'assistant', content: '完成', roundId: 'round-2', createdAt: 4 },
        { id: 'user-3', role: 'user', content: '参考 @第1轮图1、@第2轮图1、@第3轮图1', roundId: 'round-3', createdAt: 5 },
        { id: 'assistant-3', role: 'assistant', content: '完成', roundId: 'round-3', createdAt: 6 },
      ],
    })

    const deleted = deleteAgentRoundFromConversation(conversation, 'round-2', 10)

    expect(deleted.rounds.map((round) => ({ id: round.id, index: round.index, parentRoundId: round.parentRoundId }))).toEqual([
      { id: 'round-1', index: 1, parentRoundId: null },
      { id: 'round-3', index: 2, parentRoundId: 'round-1' },
    ])
    expect(deleted.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'user-3', 'assistant-3'])
    expect(deleted.messages.find((message) => message.id === 'user-3')?.content).toBe('参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
    expect(deleted.activeRoundId).toBe('round-3')
    expect(deleted.updatedAt).toBe(10)
  })

  it('can remap draft mentions using the old and new active paths after deletion', () => {
    const conversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-1'],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          id: 'round-2',
          index: 2,
          parentRoundId: 'round-1',
          userMessageId: 'user-2',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-2'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
        {
          id: 'round-3',
          index: 3,
          parentRoundId: 'round-2',
          userMessageId: 'user-3',
          prompt: '第三轮',
          inputImageIds: [],
          outputTaskIds: ['task-3'],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [],
    })
    const oldPath = getActiveAgentRounds(conversation)
    const deleted = deleteAgentRoundFromConversation(conversation, 'round-2', 10)
    const newPath = getActiveAgentRounds(deleted)

    expect(remapAgentRoundMentionsForPathChange('继续参考 @第1轮图1、@第2轮图1、@第3轮图1', oldPath, newPath))
      .toBe('继续参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
  })
})

describe('agent draft lifecycle', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'openai-responses', apiKey: 'openai-key', apiMode: 'responses' })
  const draftState = {
    prompt: `参考 ${getSelectedImageMentionLabel(0)} 生成`,
    inputImages: [imageA],
    maskDraft: {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    },
    maskEditorImageId: imageA.id,
    agentEditingRoundId: 'round-a',
  }

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      appMode: 'agent',
      agentConversations: [
        agentConversation({ id: 'conversation-a' }),
        agentConversation({ id: 'conversation-b' }),
      ],
      activeAgentConversationId: 'conversation-a',
      galleryInputDraft: null,
      agentInputDrafts: {},
      agentSidebarCollapsed: false,
      agentAssetPanelCollapsed: false,
      ...draftState,
    })
  })

  it('clears visible input but keeps the agent draft when returning to gallery mode', () => {
    useStore.getState().setAppMode('gallery')

    const state = useStore.getState()
    expect(state.appMode).toBe('gallery')
    expect(state.prompt).toBe('')
    expect(state.inputImages).toEqual([])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      inputImages: draftState.inputImages,
      maskDraft: draftState.maskDraft,
      maskEditorImageId: imageA.id,
    })
  })

  it('restores the agent draft when switching back from gallery mode', () => {
    useStore.getState().setAppMode('gallery')
    useStore.getState().setAppMode('agent')

    const state = useStore.getState()
    expect(state.appMode).toBe('agent')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentEditingRoundId).toBeNull()
  })

  it('keeps the gallery draft when switching into agent mode and back', () => {
    const galleryPrompt = `画廊 ${getSelectedImageMentionLabel(0)} 草稿`
    useStore.setState({
      appMode: 'gallery',
      prompt: galleryPrompt,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      agentInputDrafts: {
        'conversation-a': {
          prompt: draftState.prompt,
          inputImages: draftState.inputImages,
          maskDraft: draftState.maskDraft,
          maskEditorImageId: imageA.id,
        },
      },
    })

    useStore.getState().setAppMode('agent')

    let state = useStore.getState()
    expect(state.appMode).toBe('agent')
    expect(state.galleryInputDraft).toMatchObject({ prompt: galleryPrompt, inputImages: [imageB] })
    expect(state.prompt).toBe(draftState.prompt)

    useStore.getState().setAppMode('gallery')

    state = useStore.getState()
    expect(state.appMode).toBe('gallery')
    expect(state.prompt).toBe(galleryPrompt)
    expect(state.inputImages).toEqual([imageB])
  })

  it('persists the gallery draft while agent mode is active', () => {
    const galleryPrompt = 'gallery draft'
    useStore.setState({
      appMode: 'agent',
      galleryInputDraft: {
        prompt: galleryPrompt,
        inputImages: [imageB],
        maskDraft: null,
        maskEditorImageId: null,
      },
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe(galleryPrompt)
    expect(persisted.inputImages).toEqual([{ id: imageB.id, dataUrl: '' }])
  })

  it('clears stale mentions in the visible input when switching conversations', () => {
    useStore.getState().setActiveAgentConversationId('conversation-b')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-b')
    expect(state.prompt).toBe('')
    expect(state.inputImages).toEqual([])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']?.prompt).toBe(draftState.prompt)
  })

  it('restores the previous conversation draft when switching back', () => {
    useStore.getState().setActiveAgentConversationId('conversation-b')
    useStore.getState().setActiveAgentConversationId('conversation-a')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-a')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentEditingRoundId).toBeNull()
  })

  it('saves and restores the agent target asset slot with the active draft', () => {
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')
    useStore.getState().setActiveAgentConversationId('conversation-b')

    let state = useStore.getState()
    expect(state.agentTargetAssetSlotId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      agentTargetAssetSlotId: 'ozon_main',
    })

    useStore.getState().setActiveAgentConversationId('conversation-a')

    state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-a')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.agentTargetAssetSlotId).toBe('ozon_main')
  })

  it('keeps the current draft when selecting the already active conversation', () => {
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')
    useStore.getState().setActiveAgentConversationId('conversation-a')

    const state = useStore.getState()
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentTargetAssetSlotId).toBe('ozon_main')
  })

  it('persists agent drafts separately from the gallery input draft', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: draftState.maskDraft,
      maskEditorImageId: imageA.id,
    })
    expect(persisted.agentInputDrafts['conversation-a']?.updatedAt).toEqual(expect.any(Number))
  })

  it('removes stale agent drafts except the last active conversation', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    const staleUpdatedAt = now - 3 * 24 * 60 * 60 * 1000 - 1
    const recentUpdatedAt = now - 3 * 24 * 60 * 60 * 1000
    const activeDraft = { prompt: 'active', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: staleUpdatedAt }
    const staleDraft = { prompt: 'stale', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: staleUpdatedAt }
    const recentDraft = { prompt: 'recent', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: recentUpdatedAt }

    const cleaned = cleanStaleAgentInputDrafts({
      'conversation-a': activeDraft,
      'conversation-b': staleDraft,
      'conversation-c': recentDraft,
    }, 'conversation-a', now)

    expect(cleaned).toEqual({
      'conversation-a': activeDraft,
      'conversation-c': recentDraft,
    })
  })

})
