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

  it('is the first available workflow template', () => {
    expect(WORKFLOW_TEMPLATES[0].id).toBe(VIRTUAL_TRY_ON_POSTER_TEMPLATE.id)
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
