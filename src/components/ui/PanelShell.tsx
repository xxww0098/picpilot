import { useRef, type ReactNode } from 'react'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

interface PanelShellProps {
  open: boolean
  onClose: () => void
  title: string
  /** 标题下方的副标题，可选。 */
  subtitle?: string
  children: ReactNode
  className?: string
}

export default function PanelShell({ open, onClose, title, subtitle, children, className }: PanelShellProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useCloseOnEscape(open, onClose)
  usePreventBackgroundScroll(open, panelRef)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/40 backdrop-blur-sm animate-overlay-in">
      <div
        ref={panelRef}
        className={`m-4 flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col rounded-2xl border border-[hsl(var(--border))] bg-white shadow-2xl shadow-black/20 ring-1 ring-black/5 animate-slide-down-in dark:bg-[hsl(240_10%_12%)] dark:ring-white/10 ${className ?? ''}`.trim()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[hsl(var(--border))] px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[hsl(var(--foreground))]">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-sm text-[hsl(var(--muted-foreground))]">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg p-1.5 text-[hsl(var(--muted-foreground))] transition-[background-color,color] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary)/0.35)]"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
