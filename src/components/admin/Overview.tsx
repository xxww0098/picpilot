import type { ReactNode } from 'react'
import { fetchAdminOverview } from '../../lib/server/adminApi'
import { formatBytes, formatDurationMs } from '../../lib/ui/format'
import { getErrorTypeLabel, getProviderDisplayName } from '../../lib/shared/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
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
        <Icon className="h-4 w-4 text-[hsl(var(--muted-foreground))]" path={ICONS.calendar} />
        最近 7 天请求统计
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          accent="blue"
          icon={ICONS.activity}
          label="请求总数"
          value={String(totals.total)}
          caption="近 7 天累计"
        />
        <Kpi
          accent="emerald"
          icon={ICONS.check}
          label="成功率"
          value={`${successRate}%`}
          caption={`成功 ${totals.success} · 失败 ${totals.failure}`}
        />
        <Kpi
          accent="amber"
          icon={ICONS.clock}
          label="平均耗时"
          value={formatDurationMs(totals.avg_duration ?? 0)}
          caption="每次出图请求"
        />
        <Kpi
          accent="violet"
          icon={ICONS.image}
          label="累计图片大小"
          value={formatBytes(totals.total_output ?? 0)}
          caption="已生成输出"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={ICONS.alert} title="错误分布" iconClass="text-rose-500">
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

        <Panel icon={ICONS.server} title="服务商分布" iconClass="text-[hsl(var(--primary))]">
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
  icon: string
  label: string
  value: string
  caption: string
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 shadow-sm shadow-black/[0.03] transition-shadow hover:shadow-md hover:shadow-black/[0.05] dark:shadow-black/20">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</p>
        <span className={`grid h-7 w-7 place-items-center rounded-lg ${ACCENTS[accent]}`}>
          <Icon className="h-4 w-4" path={icon} />
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-[hsl(var(--foreground))]">{value}</p>
      <p className="mt-1 truncate text-xs text-[hsl(var(--muted-foreground))]">{caption}</p>
    </div>
  )
}

function Panel({ icon, title, iconClass, children }: { icon: string; title: string; iconClass: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[hsl(var(--foreground))]">
        <Icon className={`h-4 w-4 ${iconClass}`} path={icon} />
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

function Icon({ className, path }: { className?: string; path: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  )
}

// Lucide-style 24x24 stroke 图标路径
const ICONS = {
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  server: 'M5 3h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2zM7 7h.01M7 17h.01',
} as const
