import { useEffect, useRef, useState } from 'react'
import type { WorkflowMeta } from '../../lib/workflow/workflowStore'

// 多工作流切换器(借鉴 infinite-canvas 的「我的画布」)。展示当前工作流名 + 下拉:
// 切换、新建、重命名、复制、删除。纯展示,逻辑由 WorkflowCanvas 通过回调处理。
export default function WorkflowSwitcher({
  workflows,
  activeId,
  disabled,
  onSwitch,
  onNew,
  onRename,
  onDuplicate,
  onDelete,
}: {
  workflows: WorkflowMeta[]
  activeId: string
  disabled?: boolean
  onSwitch: (id: string) => void
  onNew: () => void
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const active = workflows.find((w) => w.id === activeId)
  const act = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
        title="切换工作流"
      >
        <svg className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
        <span className="max-w-[9rem] truncate">{active?.name ?? '工作流'}</span>
        <svg className="h-3 w-3 text-[hsl(var(--muted-foreground))]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="animate-dropdown-down absolute left-0 top-full z-10 mt-1 w-64 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 shadow-lg">
          <div className="max-h-60 overflow-y-auto">
            {workflows.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={act(() => onSwitch(w.id))}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                  w.id === activeId
                    ? 'bg-[hsl(var(--muted))] font-medium text-[hsl(var(--foreground))]'
                    : 'text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]'
                }`}
              >
                <span className="flex-1 truncate">{w.name}</span>
                {w.id === activeId && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--primary))]" />}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-[hsl(var(--border))]" />
          <div className="grid grid-cols-2 gap-1">
            <MenuButton onClick={act(onNew)}>新建</MenuButton>
            <MenuButton onClick={act(onRename)}>重命名</MenuButton>
            <MenuButton onClick={act(onDuplicate)}>复制</MenuButton>
            <MenuButton danger onClick={act(onDelete)}>删除</MenuButton>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
        danger
          ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400'
          : 'text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]'
      }`}
    >
      {children}
    </button>
  )
}
