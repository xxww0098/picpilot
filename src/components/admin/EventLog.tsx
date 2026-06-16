import { useRef, useState } from 'react'
import { downloadAdminEventsCsv, fetchAdminEvents, type AdminEventRow } from '../../lib/server/adminApi'
import { formatBytes, formatTimestamp } from '../../lib/ui/format'
import {
  getEventActionLabel,
  getApiModeLabel,
  getAppModeLabel,
  getErrorTypeLabel,
  getEventTypeLabel,
  getHttpStatusLabel,
  getParamValueLabel,
  getProviderDisplayName,
  getUserFacingErrorMessage,
} from '../../lib/shared/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import { showAppToast } from '../../lib/ui/dialog'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../lib/ui/clipboard'
import ModalShell from '../ui/ModalShell'

const PAGE_SIZE = 50
const EXPORT_MAX_DAYS = 31

function eventTypeColor(t: string): string {
  if (t === 'success') return 'text-green-600 dark:text-green-400'
  if (t === 'cancelled') return 'text-[hsl(var(--muted-foreground))]'
  return 'text-red-500'
}

function todayString(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function dayToRange(day: string): { since: number; until: number } | null {
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return null
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
  return { since: start, until: end }
}

function rangeToMs(from: string, to: string): { since: number; until: number } | null {
  const a = dayToRange(from)
  const b = dayToRange(to)
  if (!a || !b) return null
  return { since: a.since, until: b.until }
}

function formatEventDetailText(event: AdminEventRow): string {
  const lines = [
    `请求详情 #${event.id}`,
    `时间：${formatTimestamp(event.created_at)}`,
    `用户：${event.username}`,
    `结果：${getEventTypeLabel(event.event_type)}`,
    `模式：${getAppModeLabel(event.app_mode)}`,
    `操作：${getEventActionLabel(event.action_type)}`,
    `任务 ID：${event.task_id ?? '—'}`,
    `图片序号：${event.image_index == null ? '—' : event.image_index + 1}`,
    `服务商：${getProviderDisplayName(event.provider)}`,
    `模型：${event.model ?? '—'}`,
    `接口模式：${getApiModeLabel(event.api_mode)}`,
    `尺寸：${event.size ?? '—'}`,
    `质量：${getParamValueLabel('quality', event.quality)}`,
    `请求张数：${event.n_images ?? '—'}`,
    `参考图：${event.has_input_image ? `${event.has_input_image} 张` : '无'}`,
    `遮罩：${event.has_mask ? '有' : '无'}`,
    `耗时：${event.duration_ms ? `${event.duration_ms}ms` : '—'}`,
    `HTTP 状态：${getHttpStatusLabel(event.http_status)}`,
    `输出张数：${event.output_count ?? '—'}`,
    `输出大小：${event.output_bytes == null ? '—' : formatBytes(event.output_bytes)}`,
    `客户端版本：${event.client_version ?? '—'}`,
    `IP：${event.ip ?? '—'}`,
    `浏览器：${event.user_agent ?? '—'}`,
  ]

  if (event.prompt) lines.push('', '提示词：', event.prompt)
  if (event.error_message) lines.push('', '错误说明：', getUserFacingErrorMessage(event.error_message))
  if (event.error_stack) lines.push('', '技术堆栈：', event.error_stack)

  return lines.join('\n')
}

export default function EventLog() {
  const [page, setPage] = useState(0)
  const [appMode, setAppMode] = useState('')
  const [eventType, setEventType] = useState('')
  const [errorType, setErrorType] = useState('')
  const [day, setDay] = useState<string>(todayString())
  const [detail, setDetail] = useState<AdminEventRow | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const detailPanelRef = useRef<HTMLDivElement>(null)

  const range = dayToRange(day)

  const { data, loading, error } = useAsyncQuery(async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    if (appMode) params.set('app_mode', appMode)
    if (eventType) params.set('event_type', eventType)
    if (errorType) params.set('error_type', errorType)
    if (range) {
      params.set('since', String(range.since))
      params.set('until', String(range.until))
    }
    return fetchAdminEvents(params)
  }, [page, appMode, eventType, errorType, day])

  const events = data?.events ?? []
  const total = data?.total ?? 0

  function changeDay(value: string) {
    setPage(0)
    setDay(value)
  }

  async function copyDetail(row: AdminEventRow) {
    try {
      await copyTextToClipboard(formatEventDetailText(row))
      showAppToast('请求详情已复制', 'success')
    } catch (err) {
      showAppToast(getClipboardFailureMessage('复制请求详情失败', err), 'error')
    }
  }

  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={appMode}
          onChange={(e) => { setPage(0); setAppMode(e.target.value) }}
          className="rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm"
        >
          <option value="">所有模式</option>
          <option value="gallery">画廊</option>
          <option value="agent">Agent</option>
          <option value="video">Video</option>
        </select>
        <select
          value={eventType}
          onChange={(e) => { setPage(0); setEventType(e.target.value) }}
          className="rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm"
        >
          <option value="">所有结果</option>
          <option value="success">成功</option>
          <option value="failure">失败</option>
          <option value="timeout">超时</option>
          <option value="cancelled">已取消</option>
        </select>
        <select
          value={errorType}
          onChange={(e) => { setPage(0); setErrorType(e.target.value) }}
          className="rounded border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-sm"
        >
          <option value="">所有错误类型</option>
          <option value="timeout">请求超时</option>
          <option value="rate_limit">额度或限流</option>
          <option value="invalid_request">请求参数无效</option>
          <option value="auth">认证失败</option>
          <option value="server_error">服务端错误</option>
          <option value="network">网络或跨域问题</option>
          <option value="unknown">未知错误</option>
        </select>
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={day}
            max={todayString()}
            onChange={(e) => changeDay(e.target.value)}
            className="rounded border border-[hsl(var(--border))] bg-transparent px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => changeDay(todayString())}
            className="rounded border border-[hsl(var(--border))] px-2 py-1.5 text-xs hover:bg-[hsl(var(--muted))]"
          >
            今天
          </button>
          <button
            type="button"
            onClick={() => changeDay('')}
            className="rounded border border-[hsl(var(--border))] px-2 py-1.5 text-xs hover:bg-[hsl(var(--muted))]"
          >
            全部
          </button>
        </div>
        <span className="text-sm text-[hsl(var(--muted-foreground))]">共 {total} 条</span>
        <button onClick={() => setExportOpen(true)} className="ml-auto rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))]">
          批量导出 CSV
        </button>
      </div>

      {loading && <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>}
      {error && <p className="text-sm text-red-500">{getUserFacingErrorMessage(error, '加载请求记录失败')}</p>}

      {!loading && !error && (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] text-left text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                <th className="py-2 pr-3">时间</th>
                <th className="py-2 pr-3">用户</th>
                <th className="py-2 pr-3">模式</th>
                <th className="py-2 pr-3">结果</th>
                <th className="py-2 pr-3">操作</th>
                <th className="py-2 pr-3">服务商</th>
                <th className="py-2 pr-3">模型</th>
                <th className="py-2 pr-3 text-right">耗时</th>
                <th className="py-2 pr-3">错误类型</th>
                <th className="py-2 pr-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={10} className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">暂无请求记录</td></tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-b border-[hsl(var(--border))] last:border-0">
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{formatTimestamp(e.created_at)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--foreground))]">{e.username}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{getAppModeLabel(e.app_mode)}</td>
                  <td className={`py-2 pr-3 ${eventTypeColor(e.event_type)}`}>{getEventTypeLabel(e.event_type)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{getEventActionLabel(e.action_type)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{getProviderDisplayName(e.provider)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{e.model ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{e.duration_ms ? `${(e.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="py-2 pr-3 max-w-xs truncate text-red-500" title={e.error_message ? getUserFacingErrorMessage(e.error_message) : ''}>{getErrorTypeLabel(e.error_type)}</td>
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

      {exportOpen && (
        <ExportDialog
          defaultFrom={day || todayString()}
          defaultTo={day || todayString()}
          appMode={appMode}
          eventType={eventType}
          errorType={errorType}
          onClose={() => setExportOpen(false)}
        />
      )}

      {detail && (
        <ModalShell
          portal
          onClose={() => setDetail(null)}
          zIndexClass="z-50"
          paddingClass="p-0"
          backdropClassName="bg-black/40"
          panelRef={detailPanelRef}
          scrollRef={detailPanelRef}
          panelClassName="m-4 max-h-[85vh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-2xl border border-[hsl(var(--border))] bg-white p-6 shadow-xl dark:bg-[hsl(240_10%_12%)]"
        >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">请求详情 #{detail.id}</h3>
              <button
                type="button"
                onClick={() => void copyDetail(detail)}
                className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
              >
                复制详情
              </button>
            </div>
            <dl className="grid grid-cols-3 gap-y-2 text-sm">
              <Field label="时间">{formatTimestamp(detail.created_at)}</Field>
              <Field label="用户">{detail.username}</Field>
              <Field label="模式">{getAppModeLabel(detail.app_mode)}</Field>
              <Field label="结果" valueClass={eventTypeColor(detail.event_type)}>{getEventTypeLabel(detail.event_type)}</Field>
              <Field label="操作">{getEventActionLabel(detail.action_type)}</Field>
              <Field label="任务 ID">{detail.task_id ?? '—'}</Field>
              <Field label="图片序号">{detail.image_index == null ? '—' : detail.image_index + 1}</Field>
              <Field label="服务商">{getProviderDisplayName(detail.provider)}</Field>
              <Field label="模型">{detail.model ?? '—'}</Field>
              <Field label="接口模式">{getApiModeLabel(detail.api_mode)}</Field>
              <Field label="尺寸">{detail.size ?? '—'}</Field>
              <Field label="质量">{getParamValueLabel('quality', detail.quality)}</Field>
              <Field label="请求张数">{detail.n_images ?? '—'}</Field>
              <Field label="参考图">{detail.has_input_image ? `${detail.has_input_image} 张` : '无'}</Field>
              <Field label="遮罩">{detail.has_mask ? '有' : '无'}</Field>
              <Field label="耗时">{detail.duration_ms ? `${detail.duration_ms}ms` : '—'}</Field>
              <Field label="HTTP 状态">{getHttpStatusLabel(detail.http_status)}</Field>
              <Field label="输出张数">{detail.output_count ?? '—'}</Field>
              <Field label="输出大小">{detail.output_bytes == null ? '—' : formatBytes(detail.output_bytes)}</Field>
              <Field label="客户端版本">{detail.client_version ?? '—'}</Field>
              <Field label="IP">{detail.ip ?? '—'}</Field>
              <Field label="浏览器" wide>{detail.user_agent ?? '—'}</Field>
            </dl>
            {detail.prompt && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">提示词</p>
                <pre className="whitespace-pre-wrap rounded bg-[hsl(var(--muted))] p-3 text-xs">{detail.prompt}</pre>
              </div>
            )}
            {detail.error_message && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">错误说明</p>
                <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{getUserFacingErrorMessage(detail.error_message)}</pre>
              </div>
            )}
            {detail.error_stack && (
              <div className="mt-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">技术堆栈</p>
                <pre className="whitespace-pre-wrap rounded bg-[hsl(var(--muted))] p-3 text-xs">{detail.error_stack}</pre>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void copyDetail(detail)}
                className="rounded border border-[hsl(var(--border))] px-4 py-1.5 text-sm hover:bg-[hsl(var(--muted))]"
              >
                复制详情
              </button>
              <button onClick={() => setDetail(null)} className="rounded bg-[hsl(var(--primary))] px-4 py-1.5 text-sm text-[hsl(var(--primary-foreground))]">关闭</button>
            </div>
        </ModalShell>
      )}
    </div>
  )
}

function ExportDialog({
  defaultFrom,
  defaultTo,
  appMode,
  eventType,
  errorType,
  onClose,
}: {
  defaultFrom: string
  defaultTo: string
  appMode: string
  eventType: string
  errorType: string
  onClose: () => void
}) {
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [downloading, setDownloading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const today = todayString()
  const range = rangeToMs(from, to)
  const rangeDays = range ? Math.ceil((range.until - range.since) / (24 * 60 * 60 * 1000)) : 0
  const tooWide = rangeDays > EXPORT_MAX_DAYS
  const invalid = !range || rangeDays < 1
  const disabled = downloading || invalid || tooWide

  async function handleDownload() {
    if (!range) return
    setDownloading(true)
    setLocalError(null)
    try {
      const params = new URLSearchParams({
        since: String(range.since),
        until: String(range.until),
      })
      if (appMode) params.set('app_mode', appMode)
      if (eventType) params.set('event_type', eventType)
      if (errorType) params.set('error_type', errorType)
      await downloadAdminEventsCsv(params)
      showAppToast('已开始下载 CSV', 'success')
      onClose()
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <ModalShell
      portal
      onClose={downloading ? undefined : onClose}
      zIndexClass="z-50"
      paddingClass="p-0"
      backdropClassName="bg-black/40"
      panelClassName="m-4 w-full max-w-md rounded-2xl border border-[hsl(var(--border))] bg-white p-6 shadow-xl dark:bg-[hsl(240_10%_12%)]"
    >
      <h3 className="mb-1 text-base font-semibold">批量导出请求日志</h3>
      <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
        选择起止日期（含两端），单次最多 {EXPORT_MAX_DAYS} 天；将下载范围内所有匹配当前筛选条件的请求记录。
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-[hsl(var(--muted-foreground))]">
          起始日期
          <input
            type="date"
            value={from}
            max={to || today}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-[hsl(var(--border))] bg-transparent px-2 py-1.5 text-sm text-[hsl(var(--foreground))]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[hsl(var(--muted-foreground))]">
          结束日期
          <input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-[hsl(var(--border))] bg-transparent px-2 py-1.5 text-sm text-[hsl(var(--foreground))]"
          />
        </label>
      </div>
      {!invalid && (
        <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
          共 {rangeDays} 天{appMode || eventType || errorType ? '（沿用当前筛选）' : ''}。
        </p>
      )}
      {tooWide && (
        <p className="mt-3 text-xs text-red-500">范围超过 {EXPORT_MAX_DAYS} 天，请缩短。</p>
      )}
      {localError && <p className="mt-3 text-xs text-red-500">{localError}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={downloading}
          className="rounded border border-[hsl(var(--border))] px-4 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleDownload}
          disabled={disabled}
          className="rounded bg-[hsl(var(--primary))] px-4 py-1.5 text-sm text-[hsl(var(--primary-foreground))] disabled:opacity-50"
        >
          {downloading ? '导出中…' : '下载 CSV'}
        </button>
      </div>
    </ModalShell>
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
