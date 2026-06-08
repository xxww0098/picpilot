// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  ensureStore,
  getActiveId,
  listWorkflows,
  loadWorkflowGraph,
  renameWorkflow,
  saveWorkflowGraph,
  setActiveId,
} from './workflowStore'
import type { WorkflowGraph, WorkflowNode } from './types'

afterEach(() => localStorage.clear())

function graphWithImage(): WorkflowGraph {
  const input: WorkflowNode = {
    id: 'n1',
    type: 'input',
    position: { x: 0, y: 0 },
    data: { kind: 'input', label: '产品图', images: [{ id: 'i1', dataUrl: 'data:image/png;base64,AAAA' }] },
  }
  return { version: 1, nodes: [input], edges: [] }
}

describe('workflowStore', () => {
  it('initializes a default workflow when empty', () => {
    const idx = ensureStore()
    expect(idx.items.length).toBe(1)
    expect(idx.activeId).toBe(idx.items[0].id)
  })

  it('migrates the legacy single-graph key into the first workflow', () => {
    localStorage.setItem('picpilot.workflow.graph.v1', JSON.stringify({ version: 1, nodes: [{ id: 'x', type: 'text', position: { x: 0, y: 0 }, data: { kind: 'text', label: 't', text: 'hi' } }], edges: [] }))
    const idx = ensureStore()
    expect(localStorage.getItem('picpilot.workflow.graph.v1')).toBeNull() // legacy removed
    const g = loadWorkflowGraph(idx.activeId)
    expect(g?.nodes[0]?.id).toBe('x')
  })

  it('creates, lists (desc by updatedAt), and switches workflows', () => {
    ensureStore()
    const a = createWorkflow('甲')
    const b = createWorkflow('乙')
    expect(getActiveId()).toBe(b.id) // newest active
    const names = listWorkflows().map((w) => w.name)
    expect(names).toContain('甲')
    expect(names).toContain('乙')
    setActiveId(a.id)
    expect(getActiveId()).toBe(a.id)
  })

  it('saves a graph stripped of image data and reloads it', () => {
    const a = createWorkflow('图工作流')
    saveWorkflowGraph(a.id, graphWithImage())
    const loaded = loadWorkflowGraph(a.id)
    const node = loaded?.nodes[0]
    expect(node?.data.kind).toBe('input')
    if (node?.data.kind === 'input') expect(node.data.images).toEqual([]) // stripped
  })

  it('renames and duplicates (copying the graph)', () => {
    const a = createWorkflow('原始')
    saveWorkflowGraph(a.id, graphWithImage())
    renameWorkflow(a.id, '改名后')
    expect(listWorkflows().find((w) => w.id === a.id)?.name).toBe('改名后')
    const dup = duplicateWorkflow(a.id)
    expect(dup.name).toContain('副本')
    expect(loadWorkflowGraph(dup.id)?.nodes.length).toBe(1) // graph copied
  })

  it('deleting the last workflow recreates an empty one', () => {
    const idx = ensureStore()
    const only = idx.items[0].id
    const newActive = deleteWorkflow(only)
    expect(listWorkflows().length).toBe(1)
    expect(newActive).not.toBe(only)
    expect(getActiveId()).toBe(newActive)
  })
})
