import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** 管理面板常用卡片容器，对齐各页 rounded-xl border 重复样式 */
export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardSection({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  )
}

export function CardHeaderRow({
  label,
  action,
  className,
}: {
  label: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</dt>
      {action}
    </div>
  )
}
