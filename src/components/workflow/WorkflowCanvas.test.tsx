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
    expect(screen.getByText('加载模板')).toBeTruthy()
    expect(screen.getByText('加载示例模板')).toBeTruthy()
  })

  it('loads the e-commerce template and renders all 7 nodes', () => {
    const { container } = render(<WorkflowCanvas />)
    fireEvent.click(screen.getByText('加载示例模板'))
    // 模板 = 2 输入 + 4 生成 + 1 输出 = 7 个节点
    expect(container.querySelectorAll('.react-flow__node').length).toBe(7)
    // 节点标题文本渲染正常
    expect(screen.getByText('产品图')).toBeTruthy()
    expect(screen.getByText('主图 Banner')).toBeTruthy()
    expect(screen.getByText('详情页素材')).toBeTruthy()
  })
})
