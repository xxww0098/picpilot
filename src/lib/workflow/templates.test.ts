import { describe, expect, it } from 'vitest'
import { topologicalOrder, validateGraph } from './engine'
import { ECOMMERCE_DETAIL_TEMPLATE } from './templates'

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
