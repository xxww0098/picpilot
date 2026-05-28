import { useCallback, useEffect, useState } from 'react'
import { authFetch } from '../../lib/auth'

interface EventRow {
  id: number
  user_id: string
  username: string
  event_type: string
  provider: string | null
  api_mode: string | null
  model: string | null
  size: string | null
  quality: string | null
  n_images: number | null
  has_input_image: number | null
  has_mask: number | null
  prompt: string | null
  duration_ms: number | null
  http_status: number | null
  error_type: string | null
  error_message: string | null
  error_stack: string | null
  output_count: number | null
  output_bytes: number | null
  user_agent: string | null
  ip: string | null
  client_version: string | null
  created_at: number
}

const PAGE_SIZE = 50

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString()
}

function eventTypeColor(t: string): string {
  if (t === 'success') return 'text-green-600 dark:text-green-400'
  if (t === 'cancelled') return 'text-[hsl(var(--muted-foreground))]'
  return 'text-red-500'
}

export default function EventLog() {
  const [events, setEvents] = useState<EventRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [eventType, setEventType] = useState('')
  const [errorType, setErrorType] = useState('')
  const [detail, setDetail] = useState<EventRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
      if (eventType) params.set('event_type', eventType)
      if (errorType) params.set('error_type', errorType)
      const res = await authFetch(`/api/admin/events?${params}`)
      if (!res.ok) throw new Error('加载失败')
      const data = (await res.json()) as { events: EventRow[]; total: number }
      setEvents(data.events)
      setTotal(data.total)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, eventType, errorType])

  useEffect(() => {
    void load()
  }, [load])

  function exportCsv() {
    const cols: Array<keyof EventRow> = ['created_at', 'username', 'event_type', 'provider', 'model', 'duration_ms', 'error_type', 'error_message', 'prompt']
    const header = cols.join(',')
    const rows = events.map((e) =>
      cols.map((c) => {
        const v = e[c]
        if (v == null) return ''
        const s = String(v).replace(/"/g, '""')
        return `"${s}"`
      }).join(','),
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `events-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={eventType}
          onChange={(e) => { setPage(0); setEventType(e.target.value) }}
          className="rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm"
        >
          <option value="">所有类型</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
          <option value="timeout">timeout</option>
          <option value="cancelled">cancelled</option>
        </select>
        <select
          value={errorType}
          onChange={(e) => { setPage(0); setErrorType(e.target.value) }}
          className="rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm"
        >
          <option value="">所有错误</option>
          <option value="timeout">timeout</option>
          <option value="rate_limit">rate_limit</option>
          <option value="invalid_request">invalid_request</option>
          <option value="auth">auth</option>
          <option value="server_error">server_error</option>
          <option value="network">network</option>
          <option value="unknown">unknown</option>
        </select>
        <span className="text-sm text-[hsl(var(--muted-foreground))]">共 {total} 条</span>
        <button onClick={exportCsv} className="ml-auto rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))]">
          导出 CSV
        </button>
      </div>

      {loading && <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {!loading && !error && (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] text-left text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                <th className="py-2 pr-3">时间</th>
                <th className="py-2 pr-3">用户</th>
                <th className="py-2 pr-3">类型</th>
                <th className="py-2 pr-3">Provider</th>
                <th className="py-2 pr-3">Model</th>
                <th className="py-2 pr-3 text-right">耗时</th>
                <th className="py-2 pr-3">错误</th>
                <th className="py-2 pr-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={8} className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">无数据</td></tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-b border-[hsl(var(--border))] last:border-0">
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{formatTs(e.created_at)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--foreground))]">{e.username}</td>
                  <td className={`py-2 pr-3 ${eventTypeColor(e.event_type)}`}>{e.event_type}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{e.provider ?? '—'}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{e.model ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{e.duration_ms ? `${(e.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="py-2 pr-3 max-w-xs truncate text-red-500" title={e.error_message ?? ''}>{e.error_type ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <button onClick={() => setDetail(e)} className="text-xs text-[hsl(var(--primary))] hover:underline">详情</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between text-sm">
            <span className="text-[hsl(var(--muted-foreground))]">第 {page + 1} / {maxPage + 1} 页</span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded border border-[hsl(var(--border))] px-3 py-1 disabled:opacity-50"
              >
                上一页
              </button>
              <button
                disabled={page >= maxPage}
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                className="rounded border border-[hsl(var(--border))] px-3 py-1 disabled:opacity-50"
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDetail(null)}>
          <div className="m-4 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[hsl(var(--border))] bg-white p-6 shadow-xl dark:bg-[hsl(240_10%_12%)]" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-base font-semibold">事件详情 #{detail.id}</h3>
            <dl className="grid grid-cols-3 gap-y-2 text-sm">
              <Field label="时间">{formatTs(detail.created_at)}</Field>
              <Field label="用户">{detail.username}</Field>
              <Field label="类型" valueClass={eventTypeColor(detail.event_type)}>{detail.event_type}</Field>
              <Field label="Provider">{detail.provider ?? '—'}</Field>
              <Field label="Model">{detail.model ?? '—'}</Field>
              <Field label="API Mode">{detail.api_mode ?? '—'}</Field>
              <Field label="Size">{detail.size ?? '—'}</Field>
              <Field label="Quality">{detail.quality ?? '—'}</Field>
              <Field label="N 张">{detail.n_images ?? '—'}</Field>
              <Field label="编辑模式">{detail.has_input_image ? `${detail.has_input_image} 输入图` : '否'}</Field>
              <Field label="蒙版">{detail.has_mask ? '是' : '否'}</Field>
              <Field label="耗时">{detail.duration_ms ? `${detail.duration_ms}ms` : '—'}</Field>
              <Field label="HTTP">{detail.http_status ?? '—'}</Field>
              <Field label="输出张数">{detail.output_count ?? '—'}</Field>
              <Field label="输出字节">{detail.output_bytes ?? '—'}</Field>
              <Field label="客户端版本">{detail.client_version ?? '—'}</Field>
              <Field label="IP">{detail.ip ?? '—'}</Field>
              <Field label="UA" wide>{detail.user_agent ?? '—'}</Field>
            </dl>
            {detail.prompt && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Prompt</p>
                <pre className="whitespace-pre-wrap rounded bg-[hsl(var(--muted))] p-3 text-xs">{detail.prompt}</pre>
              </div>
            )}
            {detail.error_message && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">错误</p>
                <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{detail.error_message}</pre>
              </div>
            )}
            {detail.error_stack && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">堆栈</p>
                <pre className="whitespace-pre-wrap rounded bg-[hsl(var(--muted))] p-3 text-xs">{detail.error_stack}</pre>
              </div>
            )}
            <button onClick={() => setDetail(null)} className="mt-4 rounded bg-[hsl(var(--primary))] px-4 py-1.5 text-sm text-[hsl(var(--primary-foreground))]">关闭</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children, wide, valueClass }: { label: string; children: React.ReactNode; wide?: boolean; valueClass?: string }) {
  return (
    <>
      <dt className="text-xs text-[hsl(var(--muted-foreground))]">{label}</dt>
      <dd className={`col-span-2 break-all ${valueClass ?? 'text-[hsl(var(--foreground))]'} ${wide ? 'col-span-2' : ''}`}>{children}</dd>
    </>
  )
}
