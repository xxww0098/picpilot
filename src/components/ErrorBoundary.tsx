import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger, serializeError } from '../lib/logger'

// 「代码块加载失败」识别：常见于发布新版本后，旧页面 / 旧 PWA 仍引用已被替换、带哈希的 lazy chunk，
// 该 chunk 在服务器上已不存在 → import() 404 拒绝。此时自动刷新即可拉取最新资源。
function isChunkLoadError(error: unknown): boolean {
  if (!error) return false
  const name = (error as { name?: string }).name ?? ''
  const message = (error as { message?: string }).message ?? ''
  return (
    name === 'ChunkLoadError' ||
    /Loading (?:CSS )?chunk \d+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  )
}

const RELOAD_GUARD_KEY = 'picpilot-chunk-reload-at'
const RELOAD_DEBOUNCE_MS = 20_000

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  reloading: boolean
}

// 全局错误边界：把「白屏」换成可恢复的提示。
// - chunk 加载失败（发布后旧页面）：自动刷新一次拉取新版本（带去抖，避免刷新死循环）。
// - 其他渲染错误：展示提示 + 手动刷新按钮，并打印错误供排查。
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const chunk = isChunkLoadError(error)
    logger.error('boundary', '渲染错误被全局 ErrorBoundary 捕获', {
      chunk,
      error: serializeError(error),
      componentStack: info.componentStack,
    })
    if (chunk && this.shouldAutoReload()) {
      try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())) } catch { /* sessionStorage 不可用时忽略 */ }
      this.setState({ reloading: true })
      window.location.reload()
    }
  }

  // 去抖：同一会话短时间内只自动刷新一次，避免新版本仍缺该 chunk 时陷入刷新死循环。
  shouldAutoReload(): boolean {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0)
      return !Number.isFinite(last) || Date.now() - last > RELOAD_DEBOUNCE_MS
    } catch {
      return true
    }
  }

  render() {
    const { error, reloading } = this.state
    if (!error) return this.props.children

    if (reloading) {
      return <Notice title="正在更新到最新版本…" />
    }

    const chunk = isChunkLoadError(error)
    return (
      <Notice
        title={chunk ? '检测到新版本' : '页面出错了'}
        message={chunk ? '请刷新页面以加载最新版本。' : '可尝试刷新页面恢复；如反复出现，请把下方信息发给管理员。'}
        detail={chunk ? undefined : error.message}
        onReload={() => window.location.reload()}
      />
    )
  }
}

function Notice({ title, message, detail, onReload }: { title: string; message?: string; detail?: string; onReload?: () => void }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h1>
        {message && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{message}</p>}
        {detail && (
          <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-100 p-3 text-left text-xs text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
            {detail}
          </pre>
        )}
      </div>
      {onReload && (
        <button
          type="button"
          onClick={onReload}
          className="rounded-xl bg-[hsl(var(--primary))] px-5 py-2.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition hover:opacity-90"
        >
          刷新页面
        </button>
      )}
    </div>
  )
}
