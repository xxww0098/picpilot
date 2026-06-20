// store 测试的共享 setup：vi.mock 工厂与测试数据 helper。
// 注意：vi.mock 按文件 hoisted，各测试文件需自行调用：
//   vi.mock('./lib/shared/db', async () => (await import('./storeTestSetup')).createDbMock())
//   vi.mock('./lib/image/api', async () => (await import('./storeTestSetup')).createApiMock())
//   vi.mock('./lib/agent/agentApi', async () => (await import('./storeTestSetup')).createAgentApiMock())
import { vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import type { AgentConversation, ExportData, StoredImage, StoredImageThumbnail, StoredVideo, TaskRecord } from './types'

export function createDbMock() {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  const videos = new Map<string, StoredVideo>()
  const agentConversations = new Map<string, AgentConversation>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getAllAgentConversations: async () => [...agentConversations.values()],
    putAgentConversation: async (conversation: AgentConversation) => {
      agentConversations.set(conversation.id, conversation)
      return conversation.id
    },
    deleteAgentConversation: async (id: string) => {
      agentConversations.delete(id)
    },
    clearAgentConversations: async () => {
      agentConversations.clear()
    },
    replaceAgentConversations: async (conversations: AgentConversation[]) => {
      agentConversations.clear()
      for (const conversation of conversations) agentConversations.set(conversation.id, conversation)
    },
    getImage: async (id: string) => images.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
    putVideo: async (video: StoredVideo) => {
      videos.set(video.id, video)
      return video.id
    },
    deleteVideo: async (id: string) => {
      videos.delete(id)
    },
    // 测试里永远不会写满存储，没有可驱逐项
    evictOldestImages: async (_count: number): Promise<string[]> => [],
    requestPersistentStorage: async () => false,
    isQuotaExceededError: (_err: unknown) => false,
    isStorageFullError: (_err: unknown) => false,
    StorageFullError: class StorageFullError extends Error {
      readonly isStorageFull = true
    },
  }
}

export function createApiMock() {
  return {
    callImageApi: vi.fn(async () => ({
      images: [],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })),
  }
}

export function createAgentApiMock() {
  return {
    callAgentConversationTitleApi: vi.fn(async () => '标题'),
    callAgentResponsesApi: vi.fn(() => new Promise(() => {})),
    callBatchImageSingle: vi.fn(async (opts: { batchItemId: string; prompt: string }) => ({
      batchItemId: opts.batchItemId,
      image: { dataUrl: 'data:image/png;base64,batch-output', revisedPrompt: opts.prompt },
      error: null,
    })),
    parseBatchImageCallArguments: vi.fn((args: string) => {
      try {
        const parsed = JSON.parse(args) as { images?: Array<{ id?: string; prompt?: string }> }
        return parsed.images?.map((item, index) => ({
          id: item.id || `image_${index + 1}`,
          prompt: item.prompt || '',
        })) ?? null
      } catch {
        return null
      }
    }),
  }
}

export const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
export const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

export function agentConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: '新对话',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...overrides,
  }
}

export function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

export function importFile(data: ExportData): File {
  const zipped = zipSync({ 'manifest.json': strToU8(JSON.stringify(data)) })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
  return { arrayBuffer: async () => buffer } as File
}
