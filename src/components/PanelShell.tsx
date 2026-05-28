import { useRef, type ReactNode } from 'react'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

interface PanelShellProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  className?: string
}

export default function PanelShell({ open, onClose, title, children, className }: PanelShellProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useCloseOnEscape(open, onClose)
  usePreventBackgroundScroll(open, panelRef)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/40 backdrop-blur-sm">
      <div ref={panelRef} className={`m-4 flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col rounded-2xl border border-[hsl(var(--border))] bg-white shadow-xl dark:bg-[hsl(240_10%_12%)] ${className ?? ''}`.trim()}>
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-6 py-4">
          <h2 className="text-lg font-semibold text-[hsl(var(--foreground))]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
            aria-label="关闭"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
