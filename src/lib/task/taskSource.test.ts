import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'
import { getTaskFailedImageSource, hasMixedTaskImageSources } from './taskSource'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS, n: 2 },
    apiProvider: 'openai',
    apiProfileId: 'api-profile',
    apiProfileName: 'OpenAI API',
    apiMode: 'images',
    apiModel: 'gpt-image-1',
    upstreamMode: 'api',
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1000,
    ...overrides,
  }
}

describe('taskSource', () => {
  it('falls back to the task source for older failed image slots', () => {
    const source = getTaskFailedImageSource(task({ failedImageCount: 1 }))

    expect(source.upstreamMode).toBe('api')
    expect(source.apiProfileName).toBe('OpenAI API')
  })

  it('treats a failed slot from another upstream mode as mixed source', () => {
    const record = task({
      outputImages: ['image-a'],
      sourceByImage: {
        'image-a': {
          apiProvider: 'openai',
          apiProfileId: 'api-profile',
          apiProfileName: 'OpenAI API',
          apiMode: 'images',
          apiModel: 'gpt-image-1',
          upstreamMode: 'api',
        },
      },
      failedImageCount: 1,
      failedImageSource: {
        apiProvider: 'openai',
        apiProfileId: 'reverse-profile',
        apiProfileName: 'OpenAI Reverse',
        apiMode: 'images',
        apiModel: 'gpt-image-1',
        upstreamMode: 'reverse',
      },
    })

    expect(hasMixedTaskImageSources(record)).toBe(true)
  })

  it('does not mark a failed slot as mixed when it matches the successful image source', () => {
    const record = task({
      outputImages: ['image-a'],
      sourceByImage: {
        'image-a': {
          apiProvider: 'openai',
          apiProfileId: 'api-profile',
          apiProfileName: 'OpenAI API',
          apiMode: 'images',
          apiModel: 'gpt-image-1',
          upstreamMode: 'api',
        },
      },
      failedImageCount: 1,
      failedImageSource: {
        apiProvider: 'openai',
        apiProfileId: 'api-profile',
        apiProfileName: 'OpenAI API',
        apiMode: 'images',
        apiModel: 'gpt-image-1',
        upstreamMode: 'api',
      },
    })

    expect(hasMixedTaskImageSources(record)).toBe(false)
  })
})
