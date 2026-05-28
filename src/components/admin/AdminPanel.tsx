import { useState } from 'react'
import { CloseIcon } from '../icons'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../../hooks/usePreventBackgroundScroll'
import Overview from './Overview'
import UserList from './UserList'
import InviteManager from './InviteManager'
import EventLog from './EventLog'

type Tab = 'overview' | 'users' | 'invites' | 'events'

interface Props {
  open: boolean
  onClose: () => void
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'invites', label: '邀请码' },
  { id: 'events', label: '事件流水' },
]

export default function AdminPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('overview')

  useCloseOnEscape(open, onClose)
  usePreventBackgroundScroll(open)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/40 backdrop-blur-sm">
      <div className="m-4 flex w-full max-w-6xl flex-col rounded-2xl border border-[hsl(var(--border))] bg-white shadow-xl dark:bg-[hsl(240_10%_12%)]">
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-6 py-4">
          <h2 className="text-lg font-semibold text-[hsl(var(--foreground))]">管理面板</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
            aria-label="关闭"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-1 border-b border-[hsl(var(--border))] px-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative px-4 py-3 text-sm transition-colors ${
                tab === t.id
                  ? 'text-[hsl(var(--foreground))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
              }`}
            >
              {t.label}
              {tab === t.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[hsl(var(--primary))]" />
              )}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'overview' && <Overview />}
          {tab === 'users' && <UserList />}
          {tab === 'invites' && <InviteManager />}
          {tab === 'events' && <EventLog />}
        </div>
      </div>
    </div>
  )
}
