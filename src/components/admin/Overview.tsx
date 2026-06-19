import type { ReactNode } from 'react'
import { fetchAdminOverview } from '../../lib/server/adminApi'
import { formatBytes, formatDurationMs } from '../../lib/ui/format'
import { getErrorTypeLabel, getProviderDisplayName } from '../../lib/shared/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import {
  ActivityIcon,
  AlertIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  PhotoIcon,
  ServerIcon,
} from '../ui/icons'
import QueryState from './QueryState'

export default function Overview() {
  const { data, loading, error } = useAsyncQuery(() => fetchAdminOverview(), [])

  return (
    <QueryState loading={loading} error={error}>
      {data && <OverviewContent data={data} />}
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
      <div className="flex items-center gap-2 text-sm font-medium text-[hsl(var(--foreground))]">
        <CalendarIcon className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
        最近 7 天请求统计
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          accent="blue"
          icon={<ActivityIcon className="h-4 w-4" />}
          label="请求总数"
          value={String(totals.total)}
          caption="近 7 天累计"
        />
        <Kpi
          accent="emerald"
          icon={<CheckIcon className="h-4 w-4" />}
          label="成功率"
          value={`${successRate}%`}
          caption={`成功 ${totals.success} · 失败 ${totals.failure}`}
        />
        <Kpi
          accent="amber"
          icon={<ClockIcon className="h-4 w-4" />}
          label="平均耗时"
          value={formatDurationMs(totals.avg_duration ?? 0)}
          caption="每次出图请求"
        />
        <Kpi
          accent="violet"
          icon={<PhotoIcon className="h-4 w-4" />}
          label="累计图片大小"
          value={formatBytes(totals.total_output ?? 0)}
          caption="已生成输出"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="错误分布" icon={<AlertIcon className="h-4 w-4 text-rose-500" />}>
          {errors.length === 0 ? (
            <Empty>暂无错误</Empty>
          ) : (
            <div className="space-y-3">
              {errors.map((e) => (
                <Bar
                  key={e.error_type}
                  label={getErrorTypeLabel(e.error_type)}
                  value={e.n}
                  max={errorMax}
                  total={totals.total}
                  fillClass="bg-gradient-to-r from-rose-400 to-red-500"
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="服务商分布" icon={<ServerIcon className="h-4 w-4 text-[hsl(var(--primary))]" />}>
          {providers.length === 0 ? (
            <Empty>暂无数据</Empty>
          ) : (
            <div className="space-y-3">
              {providers.map((p) => (
                <Bar
                  key={p.provider}
                  label={getProviderDisplayName(p.provider)}
                  value={p.n}
                  max={providerMax}
                  total={totals.total}
                  fillClass="bg-gradient-to-r from-[hsl(var(--primary))] to-[hsl(var(--primary)/0.65)]"
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

const ACCENTS = {
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
} as const

function Kpi({
  accent,
  icon,
  label,
  value,
  caption,
}: {
  accent: keyof typeof ACCENTS
  icon: ReactNode
  label: string
  value: string
  caption: string
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 shadow-sm shadow-black/[0.03] transition-shadow hover:shadow-md hover:shadow-black/[0.05] dark:shadow-black/20">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</p>
        <span className={`grid h-7 w-7 place-items-center rounded-lg ${ACCENTS[accent]}`}>
          {icon}
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-[hsl(var(--foreground))]">{value}</p>
      <p className="mt-1 truncate text-xs text-[hsl(var(--muted-foreground))]">{caption}</p>
    </div>
  )
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[hsl(var(--foreground))]">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function Bar({ label, value, max, total, fillClass }: { label: string; value: number; max: number; total: number; fillClass: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0
  const pct = total > 0 ? ((value / total) * 100).toFixed(0) : '0'
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate text-[hsl(var(--foreground))]">{label}</span>
        <span className="shrink-0 tabular-nums text-[hsl(var(--muted-foreground))]">
          <span className="font-semibold text-[hsl(var(--foreground))]">{value}</span>
          <span className="ml-1.5 text-xs">{pct}%</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
        <div className={`h-full rounded-full ${fillClass}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">{children}</p>
}
