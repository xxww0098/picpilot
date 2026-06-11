import { describe, expect, it } from 'vitest'
import { topologicalOrder, validateGraph } from './engine'
import { ECOMMERCE_DETAIL_TEMPLATE, VIDEO_STORYBOARD_TEMPLATE, VIRTUAL_TRY_ON_POSTER_TEMPLATE, WORKFLOW_TEMPLATES } from './templates'

describe('VIRTUAL_TRY_ON_POSTER_TEMPLATE', () => {
  it('builds a valid virtual try-on poster graph', () => {
    const g = VIRTUAL_TRY_ON_POSTER_TEMPLATE.build()
    expect(g.nodes.length).toBe(5) // 2 inputs + 1 text + 1 generate + 1 output
    expect(g.nodes.filter((n) => n.data.kind === 'input').length).toBe(2)
    expect(g.nodes.filter((n) => n.data.kind === 'text').length).toBe(1)
    expect(g.nodes.filter((n) => n.data.kind === 'generate').length).toBe(1)
    expect(g.edges.length).toBe(4)
    expect(topologicalOrder(g.nodes, g.edges).ok).toBe(true)
    expect(validateGraph(g.nodes, g.edges)).toEqual([])
  })

  it('uses single-image guided inputs and portrait poster output settings', () => {
    const g = VIRTUAL_TRY_ON_POSTER_TEMPLATE.build()
    const inputs = g.nodes.filter((n) => n.data.kind === 'input')
    expect(inputs.map((n) => n.data.label)).toEqual(['服装正视图', '模特样貌参考'])
    for (const input of inputs) {
      if (input.data.kind === 'input') {
        expect(input.data.maxImages).toBe(1)
        expect(input.data.description?.length).toBeGreaterThan(10)
      }
    }
    const generate = g.nodes.find((n) => n.data.kind === 'generate')
    expect(generate?.data.kind).toBe('generate')
    if (generate?.data.kind === 'generate') {
      expect(generate.data.label).toBe('试衣海报')
      expect(generate.data.params).toEqual({ size: '1024x1536', quality: 'high', n: 1 })
    }
  })

  it('is still available in the workflow template library', () => {
    expect(WORKFLOW_TEMPLATES.some((item) => item.id === VIRTUAL_TRY_ON_POSTER_TEMPLATE.id)).toBe(true)
  })
})

describe('ECOMMERCE_DETAIL_TEMPLATE', () => {
  it('builds a valid, acyclic graph that passes validation', () => {
    const g = ECOMMERCE_DETAIL_TEMPLATE.build()
    expect(g.nodes.length).toBe(7) // 2 inputs + 4 generate + 1 output
    expect(g.nodes.filter((n) => n.data.kind === 'generate').length).toBe(4)
    expect(g.edges.length).toBe(12) // 4 generate * (2 image inputs + 1 output edge)
    expect(topologicalOrder(g.nodes, g.edges).ok).toBe(true)
    expect(validateGraph(g.nodes, g.edges)).toEqual([])
  })

  it('produces unique node and edge ids', () => {
    const g = ECOMMERCE_DETAIL_TEMPLATE.build()
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length)
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length)
  })

  it('each generate node carries an inline Chinese prompt', () => {
    const g = ECOMMERCE_DETAIL_TEMPLATE.build()
    for (const n of g.nodes) {
      if (n.data.kind === 'generate') expect(n.data.prompt.trim().length).toBeGreaterThan(10)
    }
  })
})

describe('Ozon listing asset pack template', () => {
  it('is available with an embedded sample product image', () => {
    const template = WORKFLOW_TEMPLATES.find((item) => item.id === 'ozon-listing-asset-pack')
    expect(template?.name).toContain('Ozon')
    expect(template?.platform).toBe('Ozon')

    const g = template?.build()
    expect(g).toBeTruthy()
    const sample = g?.nodes.find((node) => node.data.kind === 'input' && node.data.label === '示例商品图')
    expect(sample?.data.kind).toBe('input')
    if (sample?.data.kind === 'input') {
      expect(sample.data.maxImages).toBe(1)
      expect(sample.data.images).toHaveLength(1)
      expect(sample.data.images[0].dataUrl).toMatch(/^data:image\/png;base64,/)
    }
  })

  it('builds a valid Ozon-first ecommerce image workflow', () => {
    const template = WORKFLOW_TEMPLATES.find((item) => item.id === 'ozon-listing-asset-pack')
    const g = template?.build()
    expect(g).toBeTruthy()
    if (!g) return

    expect(g.nodes.filter((node) => node.data.kind === 'input').length).toBe(2)
    expect(g.nodes.filter((node) => node.data.kind === 'text').length).toBe(1)
    expect(g.nodes.filter((node) => node.data.kind === 'generate').length).toBe(5)
    expect(g.edges.length).toBe(20)
    expect(topologicalOrder(g.nodes, g.edges).ok).toBe(true)
    expect(validateGraph(g.nodes, g.edges)).toEqual([])

    const generateLabels = g.nodes.filter((node) => node.data.kind === 'generate').map((node) => node.data.label)
    expect(generateLabels).toEqual(['Ozon 主图 3:4', 'Ozon Fresh 方图', 'Ozon 场景附图', 'Ozon 细节附图', 'Ozon 信息图'])
    const promptText = g.nodes
      .filter((node) => node.data.kind === 'generate' || node.data.kind === 'text')
      .map((node) => node.data.kind === 'generate' ? node.data.prompt : node.data.kind === 'text' ? node.data.text : '')
      .join('\n')
    expect(promptText).toContain('Ozon')
    expect(promptText).toContain('3:4')
    expect(promptText).toContain('1:1')
    expect(promptText).toContain('无水印')
    expect(promptText).toContain('不要出现价格、折扣、联系方式、社交账号或外部链接')
  })
})

describe('VIDEO_STORYBOARD_TEMPLATE', () => {
  it('builds a valid storyboard graph for video mode handoff', () => {
    const g = VIDEO_STORYBOARD_TEMPLATE.build()
    expect(g.nodes.length).toBe(6) // 1 input + 1 text + 3 generate + 1 output
    expect(g.nodes.filter((n) => n.data.kind === 'input').length).toBe(1)
    expect(g.nodes.filter((n) => n.data.kind === 'text').length).toBe(1)
    expect(g.nodes.filter((n) => n.data.kind === 'generate').length).toBe(3)
    expect(g.edges.length).toBe(9)
    expect(topologicalOrder(g.nodes, g.edges).ok).toBe(true)
    expect(validateGraph(g.nodes, g.edges)).toEqual([])
  })

  it('keeps storyboard generate nodes square and high quality', () => {
    const g = VIDEO_STORYBOARD_TEMPLATE.build()
    for (const node of g.nodes) {
      if (node.data.kind === 'generate') {
        expect(node.data.params).toEqual({ size: '1024x1024', quality: 'high', n: 1 })
      }
    }
  })
})
