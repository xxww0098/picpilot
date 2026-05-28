import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import {
  clearLogs,
  formatLogEntryAsText,
  formatLogsAsText,
  getLogEntries,
  subscribeLogs,
  type LogEntry,
  type LogLevel,
} from '../lib/logger'
import { copyTextToClipboard } from '../lib/clipboard'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon, CopyIcon, DownloadIcon, TrashIcon } from './icons'

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

const LEVEL_META: Record<LogLevel, { label: string; text: string; badge: string }> = {
  debug: { label: 'DEBUG', text: 'text-gray-500 dark:text-gray-400', badge: 'bg-gray-400/15 text-gray-500 dark:text-gray-400' },
  info: { label: 'INFO', text: 'text-sky-600 dark:text-sky-400', badge: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  warn: { label: 'WARN', text: 'text-amber-600 dark:text-amber-400', badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  error: { label: 'ERROR', text: 'text-red-600 dark:text-red-400', badge: 'bg-red-500/15 text-red-600 dark:text-red-400' },
}

function formatTime(time: number): string {
  return new Date(time).toISOString().slice(11, 23)
}

function buildSearchText(entry: LogEntry): string {
  return formatLogEntryAsText(entry).toLowerCase()
}

function downloadText(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function exportFileName(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `gpt-image-playground-logs_${stamp}.txt`
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const meta = LEVEL_META[entry.level]
  const hasData = entry.data !== undefined
  const dataText = useMemo(() => (hasData ? JSON.stringify(entry.data, null, 2) : ''), [entry.data, hasData])

  return (
    <div className="border-b border-gray-100 px-3 py-1.5 font-mono text-xs leading-relaxed dark:border-white/[0.05]">
      <button
        type="button"
        onClick={() => hasData && setExpanded((v) => !v)}
        className={`flex w-full items-start gap-2 text-left ${hasData ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">{formatTime(entry.time)}</span>
        <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${meta.badge}`}>{meta.label}</span>
        <span className="shrink-0 text-gray-400 dark:text-gray-500">[{entry.scope}]</span>
        <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${meta.text}`}>{entry.message}</span>
        {hasData && (
          <span className="shrink-0 select-none text-gray-400 dark:text-gray-500">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {hasData && expanded && (
        <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px] text-gray-600 dark:bg-black/30 dark:text-gray-300 custom-scrollbar">
          {dataText}
        </pre>
      )}
    </div>
  )
}

export default function LogPanel() {
  const open = useStore((s) => s.showLogPanel)
  const setOpen = useStore((s) => s.setShowLogPanel)
  const showToast = useStore((s) => s.showToast)
  const entries = useSyncExternalStore(subscribeLogs, getLogEntries)

  const modalRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(() => new Set(LEVELS))
  const [activeScope, setActiveScope] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)

  useCloseOnEscape(open, () => setOpen(false))
  usePreventBackgroundScroll(open, modalRef)

  const scopes = useMemo(() => {
    const set = new Set<string>()
    for (const entry of entries) set.add(entry.scope)
    return Array.from(set).sort()
  }, [entries])

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const entry of entries) counts[entry.level]++
    return counts
  }, [entries])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter((entry) => {
      if (!enabledLevels.has(entry.level)) return false
      if (activeScope !== 'all' && entry.scope !== activeScope) return false
      if (needle && !buildSearchText(entry).includes(needle)) return false
      return true
    })
  }, [entries, enabledLevels, activeScope, search])

  useEffect(() => {
    if (!open || !autoScroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open, autoScroll, filtered.length])

  if (!open) return null

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const handleCopy = async () => {
    if (!filtered.length) return
    const text = formatLogsAsText(filtered)
    try {
      await copyTextToClipboard(text)
      showToast(`已复制 ${filtered.length} 条日志`, 'success')
    } catch {
      // 非 HTTPS / 受限环境（局域网 IP、Docker 部署、内嵌页面等）下浏览器会禁用剪贴板，
      // 此时降级为下载日志文件，保证用户始终能拿到日志内容。
      downloadText(text, exportFileName())
      showToast('当前环境无法使用剪贴板，已改为下载日志文件', 'info')
    }
  }

  const handleExport = () => {
    if (!filtered.length) return
    downloadText(formatLogsAsText(filtered), exportFileName())
    showToast(`已导出 ${filtered.length} 条日志`, 'success')
  }

  const handleClear = () => {
    clearLogs()
    showToast('日志已清空', 'info')
  }

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[100] flex items-center justify-center p-2 sm:p-4"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        ref={modalRef}
        className="relative z-10 flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-white/[0.08]">
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            运行日志
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
              {filtered.length === entries.length ? `${entries.length}` : `${filtered.length}/${entries.length}`}
            </span>
          </h3>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              disabled={!filtered.length}
              className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              title="复制筛选结果"
            >
              <CopyIcon className="h-5 w-5" />
            </button>
            <button
              onClick={handleExport}
              disabled={!filtered.length}
              className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              title="导出为文件"
            >
              <DownloadIcon className="h-5 w-5" />
            </button>
            <button
              onClick={handleClear}
              disabled={!entries.length}
              className="rounded-lg p-2 text-gray-500 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-40 dark:hover:bg-red-500/10"
              title="清空日志"
            >
              <TrashIcon className="h-5 w-5" />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 工具栏 */}
        <div className="space-y-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索消息 / 来源 / 数据…"
              className="min-w-[10rem] flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 outline-none transition focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-blue-500" />
              自动滚动
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {LEVELS.map((level) => {
              const active = enabledLevels.has(level)
              const meta = LEVEL_META[level]
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => toggleLevel(level)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${active ? meta.badge : 'bg-gray-100 text-gray-400 dark:bg-white/[0.04] dark:text-gray-600'}`}
                >
                  {meta.label} {levelCounts[level]}
                </button>
              )
            })}
            <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-white/10" />
            <button
              type="button"
              onClick={() => setActiveScope('all')}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${activeScope === 'all' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'bg-gray-100 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400'}`}
            >
              全部来源
            </button>
            {scopes.map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => setActiveScope(scope)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${activeScope === scope ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'bg-gray-100 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400'}`}
              >
                {scope}
              </button>
            ))}
          </div>
        </div>

        {/* 列表 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400 dark:text-gray-500">
              {entries.length === 0 ? '暂无日志。执行图像生成等操作后这里会记录请求与响应。' : '没有符合当前筛选条件的日志。'}
            </div>
          ) : (
            filtered.map((entry) => <LogRow key={entry.id} entry={entry} />)
          )}
        </div>

        {/* 底部说明 */}
        <div className="border-t border-gray-200 px-5 py-2 text-[11px] text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
          仅保留在内存中（最近 1000 条，刷新后清空）。API Key、Authorization、base64 图片等已自动脱敏 / 截断。
        </div>
      </div>
    </div>,
    document.body,
  )
}
