import { fetchAdminOverview } from '../../lib/adminApi'
import { formatBytes, formatDurationMs } from '../../lib/format'
import { getErrorTypeLabel, getProviderDisplayName } from '../../lib/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import QueryState from './QueryState'

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="w-32 truncate text-sm text-[hsl(var(--foreground))]">{label}</span>
      <div className="relative h-5 flex-1 rounded bg-[hsl(var(--muted))]">
        <div
          className="absolute inset-y-0 left-0 rounded bg-[hsl(var(--primary))]"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-12 text-right text-sm tabular-nums text-[hsl(var(--muted-foreground))]">{value}</span>
    </div>
  )
}

export default function Overview() {
  const { data, loading, error } = useAsyncQuery(() => fetchAdminOverview(), [])

  return (
    <QueryState loading={loading} error={error}>
      {data && (
        <OverviewContent data={data} />
      )}
    </QueryState>
  )
}

function OverviewContent({ data }: { data: NonNullable<Awaited<ReturnType<typeof fetchAdminOverview>>> }) {
  const { totals, errors, providers } = data
  const successRate = totals.total > 0 ? ((totals.success / totals.total) * 100).toFixed(1) : '—'
  const errorMax = errors.reduce((m, e) => Math.max(m, e.n), 0)
  const providerMax = providers.reduce((m, p) => Math.max(m, p.n), 0)

  return (
    <div className="space-y-6">
      <p className="text-xs text-[hsl(var(--muted-foreground))]">最近 7 天请求统计</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="请求总数" value={String(totals.total)} />
        <Stat label="成功率" value={`${successRate}%`} />
        <Stat label="平均耗时" value={formatDurationMs(totals.avg_duration ?? 0)} />
        <Stat label="累计图片大小" value={formatBytes(totals.total_output ?? 0)} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-3 text-sm font-medium text-[hsl(var(--foreground))]">错误分布</h3>
          {errors.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">暂无错误</p>
          ) : (
            errors.map((e) => <Bar key={e.error_type} label={getErrorTypeLabel(e.error_type)} value={e.n} max={errorMax} />)
          )}
        </div>
        <div>
          <h3 className="mb-3 text-sm font-medium text-[hsl(var(--foreground))]">服务商分布</h3>
          {providers.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">暂无数据</p>
          ) : (
            providers.map((p) => <Bar key={p.provider} label={getProviderDisplayName(p.provider)} value={p.n} max={providerMax} />)
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] p-4">
      <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[hsl(var(--foreground))] tabular-nums">{value}</p>
    </div>
  )
}
