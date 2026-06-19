import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyVideoStatus,
  extractVideoError,
  extractVideoPosterUrl,
  extractVideoStatus,
  extractVideoTaskId,
  extractVideoUrl,
  generateVideo,
} from './videoApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('videoApi parsers (容错解析)', () => {
  it('extractVideoTaskId 兼容 id / request_id / data.* 形态', () => {
    expect(extractVideoTaskId({ id: 'abc' })).toBe('abc')
    expect(extractVideoTaskId({ request_id: 'r1' })).toBe('r1')
    expect(extractVideoTaskId({ data: { id: 'd1' } })).toBe('d1')
    expect(extractVideoTaskId({ data: { request_id: 'd2' } })).toBe('d2')
    expect(extractVideoTaskId({ foo: 'bar' })).toBeNull()
  })

  it('extractVideoStatus 兼容 status / state / data.*', () => {
    expect(extractVideoStatus({ status: 'processing' })).toBe('processing')
    expect(extractVideoStatus({ state: 'PENDING' })).toBe('PENDING')
    expect(extractVideoStatus({ data: { status: 'done' } })).toBe('done')
    expect(extractVideoStatus({})).toBe('')
  })

  it('classifyVideoStatus 正确归类完成/失败/进行中', () => {
    for (const s of ['done', 'completed', 'succeeded', 'SUCCESS', 'ready', 'finished']) {
      expect(classifyVideoStatus(s)).toBe('done')
    }
    for (const s of ['failed', 'error', 'cancelled', 'rejected']) {
      expect(classifyVideoStatus(s)).toBe('failed')
    }
    expect(classifyVideoStatus('expired')).toBe('failed')
    for (const s of ['pending', 'processing', 'queued', '']) {
      expect(classifyVideoStatus(s)).toBe('pending')
    }
  })

  it('extractVideoUrl 兼容 video.url / url / data.*.url / 数组形态', () => {
    expect(extractVideoUrl({ video: { url: 'https://x/v.mp4' } })).toBe('https://x/v.mp4')
    expect(extractVideoUrl({ url: 'https://x/u.mp4' })).toBe('https://x/u.mp4')
    expect(extractVideoUrl({ video_url: 'https://x/vu.mp4' })).toBe('https://x/vu.mp4')
    expect(extractVideoUrl({ data: { url: 'https://x/d.mp4' } })).toBe('https://x/d.mp4')
    expect(extractVideoUrl({ data: [{ url: 'https://x/arr.mp4' }] })).toBe('https://x/arr.mp4')
    expect(extractVideoUrl({ output: { url: 'https://x/o.mp4' } })).toBe('https://x/o.mp4')
    expect(extractVideoUrl({ status: 'processing' })).toBeNull()
  })

  it('extractVideoPosterUrl / extractVideoError 容错', () => {
    expect(extractVideoPosterUrl({ video: { poster_url: 'https://x/p.jpg' } })).toBe('https://x/p.jpg')
    expect(extractVideoPosterUrl({})).toBeUndefined()
    expect(extractVideoError({ error: { message: 'boom' } })).toBe('boom')
    expect(extractVideoError({ fail_reason: 'nope' })).toBe('nope')
    expect(extractVideoError({})).toBeUndefined()
  })
})

describe('generateVideo', () => {
  it('图生视频按 xAI/cliproxy 契约提交 image.url', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ video: { url: 'https://x/v.mp4' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateVideo({
      settings: {} as never,
      model: 'grok-imagine-video-1.5-preview',
      prompt: 'move',
      imageDataUrl: 'data:image/png;base64,abc',
      durationSeconds: 6,
    })

    expect(result.videoUrl).toBe('https://x/v.mp4')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      model: 'grok-imagine-video-1.5-preview',
      prompt: 'move',
      duration: 6,
      resolution: '720p',
      aspect_ratio: '16:9',
      image: { url: 'data:image/png;base64,abc' },
    })
  })

  it('上游返回非 JSON 时提示检查视频接口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not found</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })))

    await expect(generateVideo({
      settings: {} as never,
      model: 'grok-imagine-video-1.5-preview',
      prompt: 'move',
      imageDataUrl: 'data:image/png;base64,abc',
      pollIntervalMs: 0,
    })).rejects.toThrow('/v1/videos/generations')
  })
})
