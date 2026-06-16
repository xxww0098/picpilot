import { useState } from 'react'
import {
  downloadAdminDiagnostics,
  fetchAdminFailureSummary,
  fetchAdminUpstreamHealth,
  type AdminFailureSummary,
  type AdminUpstreamHealth,
} from '../../lib/server/adminApi'
import { formatBytes, formatDurationMs, formatRelative } from '../../lib/ui/format'
import {
  getAppModeLabel,
  getErrorTypeLabel,
  getFailureReasonLabel,
  getHttpStatusLabel,
  getUserFacingErrorMessage,
} from '../../lib/shared/userFacingText'
import { showAppToast } from '../../lib/ui/dialog'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import QueryState from './QueryState'

export default function Diagnostics() {
  const { data, loading, error, reload } = useAsyncQuery(async () => {
    const [summary, upstream] = await Promise.all([
      fetchAdminFailureSummary(),
      fetchAdminUpstreamHealth(),
    ])
    return { summary, upstream }
  }, [])
  const [exporting, setExporting] = useState(false)

  async function exportDiagnostics() {
    setExporting(true)
    try {
      await downloadAdminDiagnostics()
      showAppToast('诊断包已导出', 'success')
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导出诊断包失败'), 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <QueryState loading={loading} error={error}>
      {data && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">故障诊断</h3>
              <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">最近 7 天的失败原因、上游账号健康和可导出的脱敏诊断包。</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))]"
              >
                刷新
              </button>
              <button
                type="button"
                disabled={exporting}
                onClick={() => void exportDiagnostics()}
                className="rounded bg-[hsl(var(--primary))] px-3 py-1.5 text-sm font-medium text-[hsl(var(--primary-foreground))] disabled:opacity-50"
              >
                导出诊断包
              </button>
            </div>
          </div>

          <FailureSummaryPanel summary={data.summary} />
          <UpstreamHealthPanel upstream={data.upstream} />
        </div>
      )}
    </QueryState>
  )
}

function FailureSummaryPanel({ summary }: { summary: AdminFailureSummary }) {
  const total = summary.totals.reduce((sum, item) => sum + Number(item.total ?? 0), 0)
  const failure = summary.totals.reduce((sum, item) => sum + Number(item.failure ?? 0), 0)
  const successRate = total > 0 ? (((total - failure) / total) * 100).toFixed(1) : '—'
  const maxReason = summary.reasons.reduce((max, item) => Math.max(max, item.count), 0)

  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[hsl(var(--foreground))]">失败原因聚合</h4>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">成功率 {successRate}% · 失败 {failure} / 总请求 {total}</p>
        </div>
        <ModeTotals totals={summary.totals} />
      </div>

      {summary.reasons.length === 0 ? (
        <p className="py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">最近 7 天暂无失败记录</p>
      ) : (
        <div className="mt-5 space-y-3">
          {summary.reasons.slice(0, 10).map((item) => (
            <ReasonRow key={`${item.app_mode}-${item.reason}-${item.error_type}-${item.http_status}`} item={item} max={maxReason} total={failure} />
          ))}
        </div>
      )}
    </section>
  )
}

function ModeTotals({ totals }: { totals: AdminFailureSummary['totals'] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {totals.map((item) => (
        <span key={item.app_mode} className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))]">
          {getAppModeLabel(item.app_mode)} {item.failure}/{item.total}
        </span>
      ))}
    </div>
  )
}

function ReasonRow({ item, max, total }: {
  item: AdminFailureSummary['reasons'][number]
  max: number
  total: number
}) {
  const width = max > 0 ? Math.max(2, (item.count / max) * 100) : 0
  const pct = total > 0 ? ((item.count / total) * 100).toFixed(0) : '0'
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <div className="min-w-0">
          <span className="font-medium text-[hsl(var(--foreground))]">{getFailureReasonLabel(item.reason)}</span>
          <span className="ml-2 text-xs text-[hsl(var(--muted-foreground))]">
            {getAppModeLabel(item.app_mode)} · {getErrorTypeLabel(item.error_type)} · {getHttpStatusLabel(item.http_status)}
          </span>
        </div>
        <span className="shrink-0 tabular-nums text-[hsl(var(--muted-foreground))]">
          <span className="font-semibold text-[hsl(var(--foreground))]">{item.count}</span>
          <span className="ml-1.5 text-xs">{pct}% · {formatRelative(item.latest_at)}</span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
        <div className="h-full rounded-full bg-rose-500" style={{ width: `${width}%` }} />
      </div>
      {item.sample_message && (
        <p className="mt-1 truncate text-xs text-[hsl(var(--muted-foreground))]" title={item.sample_message}>
          {item.sample_message}
        </p>
      )}
    </div>
  )
}

function UpstreamHealthPanel({ upstream }: { upstream: AdminUpstreamHealth }) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[hsl(var(--foreground))]">上游账号健康</h4>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {upstream.available
              ? `已扫描 ${formatBytes(upstream.scannedBytes)} 日志，账号名已脱敏。`
              : upstream.message ?? '未配置 CLIProxy 日志目录。'}
          </p>
        </div>
        <span className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))]">
          {upstream.accounts.length} 个账号
        </span>
      </div>

      {!upstream.available ? (
        <p className="mt-5 rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
          将 CLIProxy 日志目录只读挂载到 auth 容器，并设置 CLIPROXY_LOG_DIR 后可查看账号健康。
        </p>
      ) : upstream.accounts.length === 0 ? (
        <p className="py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">日志中暂未发现账号路由记录</p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] text-left text-xs text-[hsl(var(--muted-foreground))]">
                <th className="py-2 pr-3">账号</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2 pr-3 text-right">请求</th>
                <th className="py-2 pr-3 text-right">失败率</th>
                <th className="py-2 pr-3 text-right">均耗</th>
                <th className="py-2 pr-3">最近</th>
                <th className="py-2 pr-3">建议</th>
              </tr>
            </thead>
            <tbody>
              {upstream.accounts.map((account) => (
                <tr key={account.accountKey} className="border-b border-[hsl(var(--border))] last:border-0">
                  <td className="py-2 pr-3 font-medium text-[hsl(var(--foreground))]">{account.label}</td>
                  <td className="py-2 pr-3"><HealthBadge status={account.status} /></td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{account.total}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{(account.failureRate * 100).toFixed(0)}%</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{formatDurationMs(account.avgDurationMs)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{formatRelative(account.lastSeenAt)}</td>
                  <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{account.recommendation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function HealthBadge({ status }: { status: AdminUpstreamHealth['accounts'][number]['status'] }) {
  const cls = status === 'isolate'
    ? 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
    : status === 'watch'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  const label = status === 'isolate' ? '建议隔离' : status === 'watch' ? '观察' : '健康'
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
}
