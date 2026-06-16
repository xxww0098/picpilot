import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from './lib/shared/apiProfiles'
vi.mock('./lib/shared/db', async () => (await import('./storeTestSetup')).createDbMock())
vi.mock('./lib/image/api', async () => (await import('./storeTestSetup')).createApiMock())
vi.mock('./lib/agent/agentApi', async () => (await import('./storeTestSetup')).createAgentApiMock())
import { clearAgentConversations, getAllAgentConversations, getAllTasks, putAgentConversation, putTask as putDbTask } from './lib/shared/db'
import { getPersistedState, importData, initStore, migratePersistedState, useStore } from './store'
import { agentConversation, importFile, task } from './storeTestSetup'

describe('agent conversation persistence', () => {
  beforeEach(async () => {
    await clearAgentConversations()
  })

  it('omits agent conversations from localStorage state', () => {
    const conversation = agentConversation({
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一张图',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        responseOutput: [
          { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
          { type: 'image_generation_call', id: 'image-call-a', result: 'large-base64-a' },
          { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'large-base64-b', base64: 'large-base64-c', image: 'large-base64-d', data: 'large-base64-e' } },
        ],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一张图', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '已生成图片。', roundId: 'round-a', outputTaskIds: ['task-a'], createdAt: 2 },
      ],
    })
    useStore.setState({ agentConversations: [conversation] })

    const persisted = getPersistedState(useStore.getState())
    const serializedPersisted = JSON.stringify(persisted)

    expect('agentConversations' in persisted).toBe(false)
    expect(serializedPersisted).not.toContain('image_generation_call')
    expect(serializedPersisted).not.toContain('large-base64')
    expect(JSON.stringify(useStore.getState().agentConversations)).toContain('large-base64-a')
  })

  it('loads agent conversations from IndexedDB and migrates legacy localStorage conversations', async () => {
    const storedConversation = agentConversation({ id: 'stored-conversation', createdAt: 1, updatedAt: 1 })
    const legacyConversation = agentConversation({ id: 'legacy-conversation', createdAt: 2, updatedAt: 2 })
    await putAgentConversation(storedConversation)
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })

    await initStore()

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
    expect(state.activeAgentConversationId).toBe('legacy-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
  })

  it('strips generated image payloads from legacy task raw payloads during startup migration', async () => {
    await putDbTask(task({
      id: 'legacy-task',
      outputImages: ['image-live'],
      rawResponsePayload: JSON.stringify({
        output: [{ type: 'image_generation_call', id: 'image-call-a', result: 'legacy-task-base64' }],
      }),
    }))

    await initStore()

    const storedTasks = await getAllTasks()
    const serializedStoredTasks = JSON.stringify(storedTasks)
    expect(serializedStoredTasks).toContain('image_generation_call')
    expect(serializedStoredTasks).not.toContain('legacy-task-base64')
  })

  it('keeps agent conversations created while initStore is loading', async () => {
    const legacyConversation = agentConversation({ id: 'legacy-conversation', createdAt: 1, updatedAt: 1 })
    const earlyConversation = agentConversation({ id: 'early-conversation', createdAt: 2, updatedAt: 2 })
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })

    const initPromise = initStore()
    useStore.setState({ agentConversations: [legacyConversation, earlyConversation], activeAgentConversationId: earlyConversation.id })
    await initPromise

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['legacy-conversation', 'early-conversation'])
    expect(state.activeAgentConversationId).toBe('early-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['legacy-conversation', 'early-conversation'])
  })

  it('restores active conversation and draft when localStorage no longer stores conversations', async () => {
    const storedConversation = agentConversation({ id: 'stored-conversation', createdAt: 1, updatedAt: 1 })
    useStore.setState({
      appMode: 'agent',
      agentConversations: [],
      activeAgentConversationId: storedConversation.id,
      agentInputDrafts: {
        [storedConversation.id]: {
          prompt: '未发送草稿',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: Date.now(),
        },
      },
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })
    await putAgentConversation(storedConversation)

    await initStore()

    const state = useStore.getState()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation'])
    expect(state.activeAgentConversationId).toBe('stored-conversation')
    expect(state.agentInputDrafts['stored-conversation']?.prompt).toBe('未发送草稿')
    expect(state.prompt).toBe('未发送草稿')
  })

  it('strips generated image payloads when migrating old persisted state', () => {
    const migrated = migratePersistedState({
      settings: { ...DEFAULT_SETTINGS },
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          prompt: '画一张图',
          inputImageIds: [],
          outputTaskIds: ['task-a'],
          responseOutput: [
            { type: 'image_generation_call', id: 'image-call-a', result: 'legacy-base64-a' },
            { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'legacy-base64-b', base64: 'legacy-base64-c' } },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })

    const serializedMigrated = JSON.stringify(migrated)
    expect(serializedMigrated).not.toContain('legacy-base64')
    expect(serializedMigrated).toContain('image_generation_call')
  })
})

describe('data import', () => {
  beforeEach(async () => {
    useStore.setState({
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: null,
      showToast: vi.fn(),
    })
    await clearAgentConversations()
  })

  it('skips empty agent conversations when importing task data', async () => {
    const usedConversation = agentConversation({
      id: 'used-conversation',
      activeRoundId: 'round-a',
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
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'prompt', roundId: 'round-a', createdAt: 1 }],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [
        agentConversation({ id: 'empty-conversation' }),
        usedConversation,
      ],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['used-conversation'])
    expect(state.activeAgentConversationId).toBe('used-conversation')
  })

  it('merges imported agent conversations without replacing local conversations', async () => {
    const localConversation = agentConversation({
      id: 'local-conversation',
      title: '本地对话',
      createdAt: 1,
      updatedAt: 1,
    })
    const importedConversation = agentConversation({
      id: 'imported-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'imported prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'imported prompt', roundId: 'round-a', createdAt: 2 }],
    })
    useStore.setState({
      agentConversations: [localConversation],
      activeAgentConversationId: localConversation.id,
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [importedConversation],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['local-conversation', 'imported-conversation'])
    expect(state.activeAgentConversationId).toBe('local-conversation')
  })

  it('stores imported legacy agent conversations in IndexedDB without localStorage or image payloads', async () => {
    const importedConversation = agentConversation({
      id: 'legacy-imported-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'imported prompt',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        responseOutput: [
          { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
          { type: 'image_generation_call', id: 'image-call-a', result: { base64: 'imported-legacy-base64' } },
        ],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'imported prompt', roundId: 'round-a', createdAt: 2 }],
    })

    const imported = await importData(importFile({
      version: 2,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [importedConversation],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const indexedConversations = await getAllAgentConversations()
    const persisted = getPersistedState(useStore.getState())
    const serializedIndexedConversations = JSON.stringify(indexedConversations)
    const serializedPersisted = JSON.stringify(persisted)

    expect(imported).toBe(true)
    expect(indexedConversations.map((conversation) => conversation.id)).toEqual(['legacy-imported-conversation'])
    expect(serializedIndexedConversations).toContain('image_generation_call')
    expect(serializedIndexedConversations).not.toContain('imported-legacy-base64')
    expect('agentConversations' in persisted).toBe(false)
    expect(serializedPersisted).not.toContain('image_generation_call')
    expect(serializedPersisted).not.toContain('imported-legacy-base64')
  })

})
