// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import WorkflowCanvas from './WorkflowCanvas'

// React Flow 依赖 ResizeObserver / DOMMatrix / 量测,jsdom 不实现 —— 提供最小 shim,
// 让画布能在测试环境真正挂载(这是最接近「打开页面」的自动化冒烟)。
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver
  // @ts-expect-error jsdom 无 DOMMatrixReadOnly
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1
    constructor() {}
  }
  if (!window.matchMedia) {
    window.matchMedia = (() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('WorkflowCanvas (jsdom smoke)', () => {
  it('mounts without crashing and shows toolbar + empty-state CTA', () => {
    render(<WorkflowCanvas />)
    expect(screen.getByText('▶ 运行')).toBeTruthy()
    expect(screen.getByText('模板')).toBeTruthy()
    expect(screen.getByText('虚拟试衣海报')).toBeTruthy()
  })

  it('loads the virtual try-on poster template from the empty state', () => {
    const { container } = render(<WorkflowCanvas />)
    fireEvent.click(screen.getByText('虚拟试衣海报'))
    expect(container.querySelectorAll('.react-flow__node').length).toBe(5)
    expect(screen.getByText('服装正视图')).toBeTruthy()
    expect(screen.getByText('模特样貌参考')).toBeTruthy()
    expect(screen.getByText('试衣海报')).toBeTruthy()
    expect(screen.getByText('海报成片')).toBeTruthy()
  })

  it('loads the e-commerce template from the template menu and renders all 7 nodes', () => {
    const { container } = render(<WorkflowCanvas />)
    fireEvent.click(screen.getByText('模板'))
    fireEvent.click(screen.getByText('电商详情页一键复刻'))
    expect(container.querySelectorAll('.react-flow__node').length).toBe(7)
    expect(screen.getByText('产品图')).toBeTruthy()
    expect(screen.getByText('主图 Banner')).toBeTruthy()
    expect(screen.getByText('详情页素材')).toBeTruthy()
  })

  it('opens a node context menu and deletes that node', () => {
    const { container } = render(<WorkflowCanvas />)
    fireEvent.click(screen.getByText('虚拟试衣海报'))

    const node = screen.getByText('服装正视图').closest('.react-flow__node')
    expect(node).toBeTruthy()
    fireEvent.contextMenu(node as Element, { clientX: 200, clientY: 160 })

    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByText('删除节点'))
    expect(container.querySelectorAll('.react-flow__node').length).toBe(4)
  })

  it('duplicates a node from the context menu', () => {
    const { container } = render(<WorkflowCanvas />)
    fireEvent.click(screen.getByText('虚拟试衣海报'))

    const node = screen.getByText('服装正视图').closest('.react-flow__node')
    expect(node).toBeTruthy()
    fireEvent.contextMenu(node as Element, { clientX: 220, clientY: 180 })

    fireEvent.click(screen.getByText('创建副本'))
    expect(container.querySelectorAll('.react-flow__node').length).toBe(6)
  })

  it('copies a node and pastes it with the canvas shortcut', () => {
    const { container } = render(<WorkflowCanvas />)
    fireEvent.click(screen.getByText('虚拟试衣海报'))

    const node = screen.getByText('服装正视图').closest('.react-flow__node')
    expect(node).toBeTruthy()
    fireEvent.contextMenu(node as Element, { clientX: 220, clientY: 180 })
    fireEvent.click(screen.getByText('复制节点'))
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true })

    expect(container.querySelectorAll('.react-flow__node').length).toBe(6)
  })
})
