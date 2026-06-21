import { describe, expect, it } from 'vitest'
import {
  chooseIndex,
  choosePlacement,
  mapHolderRatioToOutputSize,
  pageBoundsForShape,
  sizeToString,
} from './placement'

// 构造 tldraw shape record 的松散视图（与运行时结构对齐）
function shape(args: {
  id: string
  type?: string
  parentId?: string
  index?: string
  x?: number
  y?: number
  w?: number
  h?: number
}): Record<string, unknown> {
  return {
    id: args.id,
    typeName: 'shape',
    type: args.type ?? 'geo',
    parentId: args.parentId ?? 'page:1',
    index: args.index ?? 'a1',
    x: args.x ?? 0,
    y: args.y ?? 0,
    props: { w: args.w ?? 100, h: args.h ?? 100 },
  }
}

describe('pageBoundsForShape', () => {
  it('返回 shape 自身坐标 + 尺寸', () => {
    const store = { 'page:1': { id: 'page:1', typeName: 'page' } }
    const s = shape({ id: 's1', x: 10, y: 20, w: 100, h: 50 })
    const bounds = pageBoundsForShape(store, s as never)
    expect(bounds).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })

  it('累加 frame 父级的 x/y', () => {
    const store = {
      'page:1': { id: 'page:1', typeName: 'page' },
      frame1: shape({ id: 'frame1', type: 'frame', x: 200, y: 100, w: 400, h: 300 }),
    }
    const child = shape({ id: 'img1', type: 'image', parentId: 'frame1', x: 10, y: 20, w: 80, h: 60 })
    const bounds = pageBoundsForShape(store, child as never)
    expect(bounds).toEqual({ x: 210, y: 120, w: 80, h: 60 })
  })

  it('箭头 shape 用 start/end 算包围盒', () => {
    const store = { 'page:1': { id: 'page:1', typeName: 'page' } }
    const arrow = {
      id: 'a1',
      typeName: 'shape',
      type: 'arrow',
      parentId: 'page:1',
      index: 'a1',
      x: 5,
      y: 5,
      props: { start: { x: 0, y: 0 }, end: { x: 50, y: 30 } },
    }
    const bounds = pageBoundsForShape(store, arrow as never)
    expect(bounds).toEqual({ x: 5, y: 5, w: 50, h: 30 })
  })

  it('返回 null 当 shape 缺失', () => {
    expect(pageBoundsForShape({}, null as never)).toBeNull()
  })
})

describe('chooseIndex', () => {
  it('空 store 返回首个 key', () => {
    const index = chooseIndex({}, 'page:1')
    expect(typeof index).toBe('string')
    expect(index.length).toBeGreaterThan(0)
  })

  it('排在所有兄弟之后', () => {
    const store = {
      s1: shape({ id: 's1', parentId: 'page:1', index: 'a0' }),
      s2: shape({ id: 's2', parentId: 'page:1', index: 'a2' }),
      s3: shape({ id: 's3', parentId: 'other', index: 'a9' }), // 不同 parent，忽略
    }
    const index = chooseIndex(store, 'page:1')
    expect(index > 'a2').toBe(true)
  })
})

describe('choosePlacement', () => {
  it('无锚点时放在 (0,0)', () => {
    const placement = choosePlacement({
      store: {},
      pageId: 'page:1',
      parentId: 'page:1',
      width: 200,
      height: 150,
    })
    expect(placement.x).toBe(0)
    expect(placement.y).toBe(0)
    expect(placement.w).toBe(200)
    expect(placement.h).toBe(150)
  })

  it('默认放锚点右侧 + margin', () => {
    const store = {
      anchor: shape({ id: 'anchor', x: 100, y: 50, w: 200, h: 100 }),
    }
    const placement = choosePlacement({
      store,
      pageId: 'page:1',
      parentId: 'page:1',
      anchorShape: store.anchor as never,
      width: 150,
      height: 100,
      margin: 40,
    })
    // 锚点右边 = 100 + 200 = 300，加 margin 40 = 340
    expect(placement.x).toBe(340)
    expect(placement.y).toBe(50)
  })

  it('右侧已有障碍时继续往右找空位', () => {
    const store = {
      anchor: shape({ id: 'anchor', x: 0, y: 0, w: 100, h: 100 }),
      obstacle: shape({ id: 'obstacle', x: 140, y: 0, w: 100, h: 100 }), // 右侧 margin=40 处
    }
    const placement = choosePlacement({
      store,
      pageId: 'page:1',
      parentId: 'page:1',
      anchorShape: store.anchor as never,
      width: 100,
      height: 100,
      margin: 40,
    })
    // 第一候选 x=140 与 obstacle 重叠，步进到 140+100+40=280
    expect(placement.x).toBeGreaterThanOrEqual(280)
  })

  it('placement=below 放锚点下方', () => {
    const store = {
      anchor: shape({ id: 'anchor', x: 0, y: 0, w: 100, h: 100 }),
    }
    const placement = choosePlacement({
      store,
      pageId: 'page:1',
      parentId: 'page:1',
      anchorShape: store.anchor as never,
      width: 100,
      height: 100,
      margin: 40,
      placement: 'below',
    })
    expect(placement.x).toBe(0)
    expect(placement.y).toBe(140) // 100 + 40
  })
})

describe('mapHolderRatioToOutputSize', () => {
  it('正方形 → 1024x1024', () => {
    expect(mapHolderRatioToOutputSize(100, 100)).toEqual({ width: 1024, height: 1024 })
  })

  it('横版 → 1536x1024', () => {
    expect(mapHolderRatioToOutputSize(320, 220)).toEqual({ width: 1536, height: 1024 })
  })

  it('竖版 → 1024x1536', () => {
    expect(mapHolderRatioToOutputSize(220, 320)).toEqual({ width: 1024, height: 1536 })
  })
})

describe('sizeToString', () => {
  it('拼接 WxH', () => {
    expect(sizeToString({ width: 1024, height: 1024 })).toBe('1024x1024')
    expect(sizeToString({ width: 1536, height: 1024 })).toBe('1536x1024')
  })
})
