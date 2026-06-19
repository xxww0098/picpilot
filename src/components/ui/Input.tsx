import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

export type InputProps = InputHTMLAttributes<HTMLInputElement>

export const inputClassName =
  'h-9 w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--muted)/0.35)] px-3 text-sm text-[hsl(var(--foreground))] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] focus:bg-[hsl(var(--background))] focus:ring-2 focus:ring-[hsl(var(--ring)/0.35)] disabled:cursor-not-allowed disabled:opacity-50'

const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, type, ...props }, ref) {
  return <input type={type} className={cn(inputClassName, className)} ref={ref} {...props} />
})

export default Input
