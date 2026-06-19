import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral:
          'border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
        primary:
          'border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]',
        success:
          'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        warning:
          'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        danger:
          'border-[hsl(var(--destructive)/0.35)] bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))]',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
)

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode
  title?: string
  className?: string
}

export default function Badge({ tone, children, title, className }: BadgeProps) {
  return (
    <span title={title} className={cn(badgeVariants({ tone }), className)}>
      {children}
    </span>
  )
}
