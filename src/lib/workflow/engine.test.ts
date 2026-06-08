import { describe, expect, it, vi } from 'vitest'
import { runWorkflow, topologicalOrder, validateGraph, type WorkflowGenerateFn } from './engine'
import { HANDLE, type EngineEdge, type EngineNode, type WorkflowImage } from './types'

const img = (id: string): WorkflowImage => ({ id, dataUrl: `data:image/png;base64,${id}` })

function inputNode(id: string, images: WorkflowImage[]): EngineNode {
  return { id, data: { kind: 'input', label: id, images } }
}
function textNode(id: string, text: string): EngineNode {
  return { id, data: { kind: 'text', label: id, text } }
}
function genNode(id: string, prompt = ''): EngineNode {
  return { id, data: { kind: 'generate', label: id, prompt, params: { size: 'auto', quality: 'auto', n: 1 }, status: 'idle', error: null, outputs: [], elapsedMs: null } }
}
function outputNode(id: string): EngineNode {
  return { id, data: { kind: 'output', label: id, images: [] } }
}
function edge(source: string, target: string, targetHandle?: string): EngineEdge {
  return { source, target, sourceHandle: HANDLE.OUT, targetHandle: targetHandle ?? HANDLE.IN }
}

/** 假出图:回显输入图片数量 + 提示词,产出一张可断言的图。 */
const echoGenerate: WorkflowGenerateFn = async ({ nodeId, prompt, images }) =>
  [img(`${nodeId}:out:${images.length}:${prompt}`)]

describe('topologicalOrder', () => {
  it('orders a linear chain', () => {
    const nodes = [genNode('b'), inputNode('a', []), outputNode('c')]
    const edges = [edge('a', 'b', HANDLE.GEN_IMAGES), edge('b', 'c')]
    const res = topologicalOrder(nodes, edges)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.order.indexOf('a')).toBeLessThan(res.order.indexOf('b'))
      expect(res.order.indexOf('b')).toBeLessThan(res.order.indexOf('c'))
    }
  })

  it('detects a cycle', () => {
    const nodes = [genNode('a'), genNode('b')]
    const edges = [edge('a', 'b', HANDLE.GEN_IMAGES), edge('b', 'a', HANDLE.GEN_IMAGES)]
    const res = topologicalOrder(nodes, edges)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.cycleNodeIds.sort()).toEqual(['a', 'b'])
  })

  it('ignores self-loops as non-cyclic for ordering', () => {
    const res = topologicalOrder([genNode('a')], [edge('a', 'a', HANDLE.GEN_IMAGES)])
    expect(res.ok).toBe(true)
  })
})

describe('runWorkflow', () => {
  it('runs input -> generate -> output and propagates images', async () => {
    const nodes = [inputNode('in', [img('p1')]), genNode('g', '生成主图'), outputNode('out')]
    const edges = [edge('in', 'g', HANDLE.GEN_IMAGES), edge('g', 'out')]
    const gen = vi.fn(echoGenerate)
    const res = await runWorkflow(nodes, edges, gen)
    expect(res.status).toBe('done')
    expect(gen).toHaveBeenCalledTimes(1)
    // generate 收到 1 张输入图 + 内联提示词
    expect(gen.mock.calls[0][0]).toMatchObject({ prompt: '生成主图', images: [img('p1')] })
    // output 汇总到 generate 的产物
    expect(res.nodeOutputs['out']).toEqual([img('g:out:1:生成主图')])
  })

  it('prefers prompt-port text over inline prompt', async () => {
    const nodes = [textNode('t', '来自文本节点'), genNode('g', '内联(应被覆盖)')]
    const edges = [edge('t', 'g', HANDLE.GEN_PROMPT)]
    const gen = vi.fn(echoGenerate)
    const res = await runWorkflow(nodes, edges, gen)
    expect(res.status).toBe('done')
    expect(gen.mock.calls[0][0].prompt).toBe('来自文本节点')
  })

  it('concatenates and dedupes images from multiple input nodes (fan-in)', async () => {
    const nodes = [inputNode('a', [img('x'), img('y')]), inputNode('b', [img('y'), img('z')]), genNode('g', 'p')]
    const edges = [edge('a', 'g', HANDLE.GEN_IMAGES), edge('b', 'g', HANDLE.GEN_IMAGES)]
    const gen = vi.fn(echoGenerate)
    await runWorkflow(nodes, edges, gen)
    const received = gen.mock.calls[0][0].images.map((i) => i.id)
    expect(received).toEqual(['x', 'y', 'z']) // y deduped
  })

  it('propagates failure: downstream generate skipped, output collects partial', async () => {
    // g1 fails; g2 depends on g1 -> skipped; g3 independent -> succeeds; out collects g2(none)+g3
    const nodes = [inputNode('in', [img('p')]), genNode('g1', 'a'), genNode('g2', 'b'), genNode('g3', 'c'), outputNode('out')]
    const edges = [
      edge('in', 'g1', HANDLE.GEN_IMAGES),
      edge('g1', 'g2', HANDLE.GEN_IMAGES),
      edge('in', 'g3', HANDLE.GEN_IMAGES),
      edge('g2', 'out'),
      edge('g3', 'out'),
    ]
    const gen: WorkflowGenerateFn = async ({ nodeId, prompt, images }) => {
      if (nodeId === 'g1') throw new Error('boom')
      return [img(`${nodeId}:${images.length}:${prompt}`)]
    }
    const res = await runWorkflow(nodes, edges, gen)
    expect(res.status).toBe('error')
    expect(res.nodeStatus['g1']).toBe('error')
    expect(res.nodeStatus['g2']).toBe('error') // skipped due to failed upstream
    expect(res.errors['g2']).toContain('上游节点失败')
    expect(res.nodeStatus['g3']).toBe('done')
    // output still collects g3's success (partial)
    expect(res.nodeOutputs['out']).toEqual([img('g3:1:c')])
  })

  it('emits per-node status updates via callback', async () => {
    const nodes = [inputNode('in', [img('p')]), genNode('g', 'go'), outputNode('out')]
    const edges = [edge('in', 'g', HANDLE.GEN_IMAGES), edge('g', 'out')]
    const updates: Array<{ id: string; status?: string }> = []
    await runWorkflow(nodes, edges, echoGenerate, {
      onNodeUpdate: (id, patch) => updates.push({ id, status: patch.status }),
    })
    const gUpdates = updates.filter((u) => u.id === 'g').map((u) => u.status)
    expect(gUpdates).toEqual(['running', 'done'])
    expect(updates.some((u) => u.id === 'out' && u.status === 'done')).toBe(true)
  })

  it('cancels before running generate when signal already aborted', async () => {
    const nodes = [inputNode('in', [img('p')]), genNode('g', 'go')]
    const edges = [edge('in', 'g', HANDLE.GEN_IMAGES)]
    const gen = vi.fn(echoGenerate)
    const res = await runWorkflow(nodes, edges, gen, { signal: AbortSignal.abort() })
    expect(res.status).toBe('canceled')
    expect(gen).not.toHaveBeenCalled()
  })
})

describe('runWorkflow concurrency', () => {
  function fanout(n: number) {
    const nodes: EngineNode[] = [inputNode('in', [img('p')])]
    const edges: EngineEdge[] = []
    for (let i = 0; i < n; i++) {
      nodes.push(genNode(`g${i}`, `p${i}`))
      edges.push(edge('in', `g${i}`, HANDLE.GEN_IMAGES))
    }
    return { nodes, edges }
  }

  function trackingGenerate() {
    const state = { active: 0, max: 0 }
    const gen: WorkflowGenerateFn = async ({ nodeId }) => {
      state.active += 1
      state.max = Math.max(state.max, state.active)
      await new Promise((r) => setTimeout(r, 5))
      state.active -= 1
      return [img(nodeId)]
    }
    return { state, gen }
  }

  it('runs independent generate nodes in parallel up to the limit', async () => {
    const { nodes, edges } = fanout(4)
    const { state, gen } = trackingGenerate()
    const res = await runWorkflow(nodes, edges, gen, { concurrency: 3 })
    expect(res.status).toBe('done')
    expect(state.max).toBe(3)
  })

  it('serializes when concurrency is 1', async () => {
    const { nodes, edges } = fanout(4)
    const { state, gen } = trackingGenerate()
    await runWorkflow(nodes, edges, gen, { concurrency: 1 })
    expect(state.max).toBe(1)
  })
})

describe('validateGraph', () => {
  it('flags missing generate node', () => {
    expect(validateGraph([inputNode('a', [])], [])).toContain('至少需要一个「生成图片」节点。')
  })

  it('flags a generate node with no prompt and no image', () => {
    const problems = validateGraph([genNode('g', '   ')], [])
    expect(problems.some((p) => p.includes('缺少提示词与输入图片'))).toBe(true)
  })

  it('passes a well-formed graph', () => {
    const nodes = [inputNode('in', [img('p')]), genNode('g', 'hello'), outputNode('out')]
    const edges = [edge('in', 'g', HANDLE.GEN_IMAGES), edge('g', 'out')]
    expect(validateGraph(nodes, edges)).toEqual([])
  })

  it('rejects non-text node on prompt port', () => {
    const nodes = [inputNode('in', [img('p')]), genNode('g', 'hi')]
    const edges = [edge('in', 'g', HANDLE.GEN_PROMPT)]
    expect(validateGraph(nodes, edges).some((p) => p.includes('提示词端口只能连'))).toBe(true)
  })
})
