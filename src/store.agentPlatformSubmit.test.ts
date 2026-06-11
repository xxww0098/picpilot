import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS } from './lib/apiProfiles'
vi.mock('./lib/db', async () => (await import('./storeTestSetup')).createDbMock())
vi.mock('./lib/api', async () => (await import('./storeTestSetup')).createApiMock())
vi.mock('./lib/agentApi', async () => (await import('./storeTestSetup')).createAgentApiMock())
import { callAgentResponsesApi, callBatchImageSingle } from './lib/agentApi'
import { submitAgentMessage, useStore } from './store'
import { agentConversation } from './storeTestSetup'

describe('agent platform submit metadata', () => {
  beforeEach(() => {
    vi.mocked(callAgentResponsesApi).mockClear()
    vi.mocked(callAgentResponsesApi).mockImplementation(() => new Promise(() => {}))
    vi.mocked(callBatchImageSingle).mockClear()
    vi.mocked(callBatchImageSingle).mockImplementation(async (opts: { batchItemId: string; prompt: string }) => ({
      batchItemId: opts.batchItemId,
      image: { dataUrl: 'data:image/png;base64,batch-output', revisedPrompt: opts.prompt },
      error: null,
    }))
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: '为 Ozon 生成主图',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      agentConversations: [agentConversation({
        id: 'conversation-platform',
        platformId: 'ozon',
        assetPlan: [{ slotId: 'ozon_main', status: 'planned', taskIds: [] }],
      })],
      activeAgentConversationId: 'conversation-platform',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('stores platform step and target slot on submitted rounds', async () => {
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()
    await vi.waitFor(() => {
      expect(callAgentResponsesApi).toHaveBeenCalledWith(expect.objectContaining({
        platformContext: expect.objectContaining({
          platformId: 'ozon',
          targetAssetSlotId: 'ozon_main',
        }),
      }))
    })

    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-platform')
    expect(conversation?.rounds[0]).toMatchObject({
      stepType: 'generate',
      targetAssetSlotId: 'ozon_main',
    })
  })

  it('adds generated platform task ids to the targeted asset plan slot', async () => {
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [{
        toolCallId: 'tool-call-ozon-main',
        dataUrl: 'data:image/png;base64,generated-ozon-main',
        revisedPrompt: 'Ozon 主图',
      }],
      outputItems: [],
      responseId: 'response-ozon-main',
    })
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    await vi.waitFor(() => {
      const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-platform')
      const slot = conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')
      expect(slot?.taskIds).toHaveLength(1)
      expect(slot?.status).toBe('ready')
    })
  })

  it('inherits the platform target slot when editing a platform-targeted round', async () => {
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [{
        toolCallId: 'tool-call-edited-ozon-main',
        dataUrl: 'data:image/png;base64,edited-ozon-main',
        revisedPrompt: '编辑后的 Ozon 主图',
      }],
      outputItems: [],
      responseId: 'response-edited-ozon-main',
    })
    useStore.setState({
      prompt: '编辑 Ozon 主图',
      agentTargetAssetSlotId: null,
      agentEditingRoundId: 'round-original',
      agentConversations: [agentConversation({
        id: 'conversation-platform',
        platformId: 'ozon',
        activeRoundId: 'round-original',
        assetPlan: [{ slotId: 'ozon_main', status: 'ready', taskIds: ['task-original'] }],
        rounds: [{
          id: 'round-original',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-original',
          assistantMessageId: 'assistant-original',
          prompt: '原始 Ozon 主图',
          inputImageIds: [],
          outputTaskIds: ['task-original'],
          stepType: 'generate',
          targetAssetSlotId: 'ozon_main',
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
        messages: [
          { id: 'user-original', role: 'user', content: '原始 Ozon 主图', roundId: 'round-original', createdAt: 1 },
          { id: 'assistant-original', role: 'assistant', content: '已完成。', roundId: 'round-original', outputTaskIds: ['task-original'], createdAt: 2 },
        ],
      })],
    })

    await submitAgentMessage()

    await vi.waitFor(() => {
      const state = useStore.getState()
      const conversation = state.agentConversations.find((item) => item.id === 'conversation-platform')
      const editedRound = conversation?.rounds.find((round) => round.id !== 'round-original')
      expect(editedRound).toMatchObject({
        stepType: 'generate',
        targetAssetSlotId: 'ozon_main',
      })
      const editedTask = state.tasks.find((task) => task.agentRoundId === editedRound?.id)
      expect(editedTask).toMatchObject({
        platformId: 'ozon',
        platformAssetSlotId: 'ozon_main',
        assetStatus: 'candidate',
      })
    })
  })

  it('marks a targeted asset plan slot needs_revision when attached batch tasks have no successful output', async () => {
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'batch-call-ozon-main',
          arguments: JSON.stringify({
            images: [{ id: 'ozon-main-failed', prompt: '生成 Ozon 主图' }],
          }),
        }],
        responseId: 'response-batch-1',
      })
      .mockResolvedValueOnce({
        text: '没有成功出图',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '没有成功出图' }] }],
        responseId: 'response-batch-2',
      })
    vi.mocked(callBatchImageSingle).mockResolvedValueOnce({
      batchItemId: 'ozon-main-failed',
      image: null,
      error: '上游未返回图片',
    })
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    await vi.waitFor(() => {
      const state = useStore.getState()
      const conversation = state.agentConversations.find((item) => item.id === 'conversation-platform')
      const slot = conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')
      expect(conversation?.rounds[0]?.status).toBe('done')
      expect(slot?.taskIds).toHaveLength(1)
      expect(slot?.status).toBe('needs_revision')
      expect(state.tasks.find((item) => item.id === slot?.taskIds[0])).toMatchObject({
        status: 'error',
        outputImages: [],
      })
    })
  })

  it('marks a started hosted image task error when the round returns no completed image', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts: Parameters<typeof callAgentResponsesApi>[0]) => {
      await opts.onImageToolStarted?.({ toolCallId: 'tool-call-started-no-image' })
      return {
        text: '没有返回图片',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '没有返回图片' }] }],
        responseId: 'response-no-image',
      }
    })
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    await vi.waitFor(() => {
      const state = useStore.getState()
      const conversation = state.agentConversations.find((item) => item.id === 'conversation-platform')
      const slot = conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')
      expect(conversation?.rounds[0]?.status).toBe('done')
      expect(slot?.taskIds).toHaveLength(1)
      expect(slot?.status).toBe('needs_revision')
      expect(state.tasks.find((item) => item.id === slot?.taskIds[0])).toMatchObject({
        status: 'error',
        error: '未返回图片',
        outputImages: [],
      })
    })
  })

  it('marks a targeted asset plan slot needs_revision when an attached task errors with the round', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts: Parameters<typeof callAgentResponsesApi>[0]) => {
      await opts.onImageToolStarted?.({ toolCallId: 'tool-call-error' })
      throw new Error('upstream broke')
    })
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    await vi.waitFor(() => {
      const state = useStore.getState()
      expect(state.showToast).toHaveBeenCalledWith(expect.stringContaining('Agent 请求失败'), 'error')
      const conversation = state.agentConversations.find((item) => item.id === 'conversation-platform')
      const slot = conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')
      expect(conversation?.rounds[0]?.status).toBe('error')
      expect(slot?.taskIds).toHaveLength(1)
      expect(slot?.status).toBe('needs_revision')
    })
  })

  it('does not mutate the asset plan when a targeted round is deleted before task attachment', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts: Parameters<typeof callAgentResponsesApi>[0]) => {
      const current = useStore.getState()
      useStore.setState({
        agentConversations: current.agentConversations.map((conversation) =>
          conversation.id === 'conversation-platform'
            ? { ...conversation, activeRoundId: null, rounds: [], messages: [] }
            : conversation,
        ),
      })
      await opts.onImageToolStarted?.({ toolCallId: 'tool-call-deleted-round' })
      return {
        text: '',
        images: [{
          dataUrl: 'data:image/png;base64,direct-after-deletion',
          revisedPrompt: 'deleted direct image',
        }],
        outputItems: [],
        responseId: 'response-deleted-round',
      }
    })
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    await vi.waitFor(() => {
      expect(useStore.getState().showToast).toHaveBeenCalledWith('Agent 已回复', 'success')
    })
    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-platform')
    expect(conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')).toEqual({
      slotId: 'ozon_main',
      status: 'planned',
      taskIds: [],
    })
    expect(conversation?.rounds).toEqual([])
    expect(conversation?.messages).toEqual([])
    expect(useStore.getState().tasks.filter((item) => item.agentConversationId === 'conversation-platform')).toEqual([])
  })

  it('does not append an error assistant message when a targeted round is deleted before failure', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async () => {
      const current = useStore.getState()
      useStore.setState({
        agentConversations: current.agentConversations.map((conversation) =>
          conversation.id === 'conversation-platform'
            ? { ...conversation, activeRoundId: null, rounds: [], messages: [] }
            : conversation,
        ),
      })
      throw new Error('upstream broke after deletion')
    })
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    await vi.waitFor(() => {
      expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('Agent 请求失败'), 'error')
    })
    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-platform')
    expect(conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')).toEqual({
      slotId: 'ozon_main',
      status: 'planned',
      taskIds: [],
    })
    expect(conversation?.rounds).toEqual([])
    expect(conversation?.messages).toEqual([])
  })
})
