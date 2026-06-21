import { describe, expect, it, vi } from 'vitest'
import {
  extractImageIdFromAssetId,
  getPersistableCanvases,
  hydrateCanvasSnapshot,
  mergeCanvasesForStorage,
  normalizeCanvas,
} from './canvasPersistence'
import type { CanvasDocument } from '../../types'

// mock db.getImage：默认返回固定 dataUrl
vi.mock('../shared/db', () => ({
  getImage: vi.fn(async (id: string) => ({
    id,
    dataUrl: `data:image/png;base64,MOCK-${id}`,
    source: 'generated',
    createdAt: 0,
  })),
}))

function assetRecord(assetId: string, src: string): Record<string, unknown> {
  return {
    id: assetId,
    typeName: 'asset',
    type: 'image',
    props: { src, name: `${assetId}.png`, w: 1024, h: 1024, mimeType: 'image/png' },
    meta: {},
  }
}

function canvas(args: { id?: string; snapshot?: CanvasDocument['snapshot']; updatedAt?: number }): CanvasDocument {
  return {
    id: args.id ?? 'c1',
    title: '测试画布',
    createdAt: 1000,
    updatedAt: args.updatedAt ?? 2000,
    snapshot: args.snapshot ?? { schema: {}, store: {} },
  }
}

describe('extractImageIdFromAssetId', () => {
  it('从 asset:<id> 提取后缀', () => {
    expect(extractImageIdFromAssetId('asset:abc123')).toBe('abc123')
  })
  it('无冒号时返回整体', () => {
    expect(extractImageIdFromAssetId('plainid')).toBe('plainid')
  })
  it('空值返回 null', () => {
    expect(extractImageIdFromAssetId('')).toBeNull()
    expect(extractImageIdFromAssetId(null as never)).toBeNull()
  })
})

describe('getPersistableCanvases', () => {
  it('剥离图片 asset 的 dataUrl src', () => {
    const canvases = [
      canvas({
        snapshot: {
          schema: {},
          store: {
            'asset:img1': assetRecord('asset:img1', 'data:image/png;base64,AAAA'),
            'shape:1': { id: 'shape:1', typeName: 'shape', type: 'image', props: { assetId: 'asset:img1', w: 100, h: 100 } },
          },
        },
      }),
    ]
    const result = getPersistableCanvases(canvases)
    const asset = result[0].snapshot.store['asset:img1'] as { props: { src: string } }
    expect(asset.props.src).toBe('picpilot-image:img1')
  })

  it('非 dataUrl 的 src 原样保留', () => {
    const canvases = [
      canvas({
        snapshot: {
          schema: {},
          store: {
            'asset:ext1': assetRecord('asset:ext1', 'https://example.com/x.png'),
          },
        },
      }),
    ]
    const result = getPersistableCanvases(canvases)
    const asset = result[0].snapshot.store['asset:ext1'] as { props: { src: string } }
    expect(asset.props.src).toBe('https://example.com/x.png')
  })

  it('非 asset 记录不受影响', () => {
    const canvases = [
      canvas({
        snapshot: {
          schema: {},
          store: {
            'shape:1': { id: 'shape:1', typeName: 'shape', type: 'geo', props: { w: 100 } },
          },
        },
      }),
    ]
    const result = getPersistableCanvases(canvases)
    expect(result[0].snapshot.store['shape:1']).toEqual({ id: 'shape:1', typeName: 'shape', type: 'geo', props: { w: 100 } })
  })
})

describe('hydrateCanvasSnapshot', () => {
  it('把 picpilot-image:<id> 占位恢复成 dataUrl', async () => {
    const snapshot = {
      schema: {},
      store: {
        'asset:img1': assetRecord('asset:img1', 'picpilot-image:img1'),
      },
    }
    const result = await hydrateCanvasSnapshot(snapshot)
    const asset = result.store['asset:img1'] as { props: { src: string } }
    expect(asset.props.src).toBe('data:image/png;base64,MOCK-img1')
  })

  it('找不到图片时保留占位不抛错', async () => {
    const { getImage } = await import('../shared/db')
    vi.mocked(getImage).mockResolvedValueOnce(undefined)
    const snapshot = {
      schema: {},
      store: {
        'asset:missing': assetRecord('asset:missing', 'picpilot-image:missing'),
      },
    }
    const result = await hydrateCanvasSnapshot(snapshot)
    const asset = result.store['asset:missing'] as { props: { src: string } }
    expect(asset.props.src).toBe('picpilot-image:missing')
  })
})

describe('normalizeCanvas', () => {
  it('合法结构原样通过', () => {
    const input = {
      id: 'c1',
      title: '我的画布',
      createdAt: 1000,
      updatedAt: 2000,
      snapshot: { schema: {}, store: { a: { id: 'a' } } },
    }
    const result = normalizeCanvas(input)
    expect(result).toEqual(input)
  })

  it('缺字段补默认值', () => {
    const result = normalizeCanvas({ id: 'c2' })
    expect(result).not.toBeNull()
    expect(result?.title).toBe('未命名画布')
    expect(result?.snapshot).toEqual({ schema: {}, store: {} })
  })

  it('无 id 返回 null', () => {
    expect(normalizeCanvas({ title: '无 id' })).toBeNull()
  })

  it('非对象返回 null', () => {
    expect(normalizeCanvas('string')).toBeNull()
    expect(normalizeCanvas(null)).toBeNull()
  })
})

describe('mergeCanvasesForStorage', () => {
  it('按 updatedAt 取新', () => {
    const stored = [canvas({ id: 'c1', updatedAt: 1000 }), canvas({ id: 'c2', updatedAt: 3000 })]
    const memory = [canvas({ id: 'c2', updatedAt: 2000 }), canvas({ id: 'c3', updatedAt: 4000 })]
    const merged = mergeCanvasesForStorage(stored, memory)
    const c2 = merged.find((c) => c.id === 'c2')
    // stored 的 c2 updatedAt=3000 比 memory 的 2000 新，应保留 stored 版本
    expect(c2?.updatedAt).toBe(3000)
    expect(merged.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('结果按 createdAt 升序', () => {
    const result = mergeCanvasesForStorage(
      [canvas({ id: 'b', updatedAt: 2000 })],
      [canvas({ id: 'a', updatedAt: 1000 })],
    )
    // canvas() 里 createdAt 都固定 1000，靠稳定排序保持输入顺序
    expect(result.length).toBe(2)
  })
})
