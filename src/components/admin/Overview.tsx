import { useEffect, useState } from 'react'
import { authFetch } from '../../lib/auth'

interface OverviewData {
  totals: {
    total: number
    success: number
    failure: number
    avg_duration: number | null
    total_output: number | null
  }
  errors: Array<{ error_type: string; n: number }>
  providers: Array<{ provider: string; n: number }>
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

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
  const [data, setData] = useState<OverviewData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    authFetch('/api/admin/overview')
      .then(async (res) => {
        if (!res.ok) throw new Error('加载失败')
        const json = (await res.json()) as OverviewData
        setData(json)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
  }, [])

  if (error) return <p className="text-sm text-red-500">{error}</p>
  if (!data) return <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>

  const { totals, errors, providers } = data
  const successRate = totals.total > 0 ? ((totals.success / totals.total) * 100).toFixed(1) : '—'
  const errorMax = errors.reduce((m, e) => Math.max(m, e.n), 0)
  const providerMax = providers.reduce((m, p) => Math.max(m, p.n), 0)

  return (
    <div className="space-y-6">
      <p className="text-xs text-[hsl(var(--muted-foreground))]">最近 7 天</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="总请求" value={String(totals.total)} />
        <Stat label="成功率" value={`${successRate}%`} />
        <Stat label="平均耗时" value={formatDuration(totals.avg_duration ?? 0)} />
        <Stat label="累计输出" value={formatBytes(totals.total_output ?? 0)} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-3 text-sm font-medium text-[hsl(var(--foreground))]">错误分布</h3>
          {errors.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">无错误</p>
          ) : (
            errors.map((e) => <Bar key={e.error_type} label={e.error_type} value={e.n} max={errorMax} />)
          )}
        </div>
        <div>
          <h3 className="mb-3 text-sm font-medium text-[hsl(var(--foreground))]">Provider 分布</h3>
          {providers.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">无数据</p>
          ) : (
            providers.map((p) => <Bar key={p.provider} label={p.provider} value={p.n} max={providerMax} />)
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
