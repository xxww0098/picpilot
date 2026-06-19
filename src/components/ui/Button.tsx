import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium outline-none transition-[background-color,opacity,border-color,color] focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring)/0.45)] disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90',
        destructive:
          'bg-[hsl(var(--destructive))] text-[hsl(var(--destructive-foreground))] hover:opacity-90',
        danger:
          'border border-[hsl(var(--destructive)/0.35)] bg-transparent text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.08)]',
        outline:
          'border border-[hsl(var(--border))] bg-transparent text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]',
        ghost: 'bg-transparent text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]',
        link: 'bg-transparent p-0 text-[hsl(var(--primary))] underline-offset-4 hover:underline focus-visible:ring-0',
        warning:
          'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))] hover:opacity-90',
      },
      size: {
        sm: 'px-3 py-1.5 text-sm',
        xs: 'px-2.5 py-1 text-xs',
        icon: 'h-8 w-8 shrink-0 p-0 text-sm',
        'icon-xs': 'h-5 w-5 shrink-0 p-0',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'sm',
    },
  },
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  children: ReactNode
}

export default function Button({ variant, size, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {children}
    </button>
  )
}
