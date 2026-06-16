import { useState } from 'react'
import PanelShell from '../ui/PanelShell'
import Overview from './Overview'
import UserList from './UserList'
import TeamSettings from './TeamSettings'
import InviteManager from './InviteManager'
import EventLog from './EventLog'
import Diagnostics from './Diagnostics'
import ReverseAuth from './ReverseAuth'

type Tab = 'overview' | 'users' | 'settings' | 'reverseAuth' | 'invites' | 'events' | 'diagnostics'

interface Props {
  open: boolean
  onClose: () => void
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'settings', label: '默认配置' },
  { id: 'reverseAuth', label: '逆向账号' },
  { id: 'invites', label: '邀请码' },
  { id: 'events', label: '事件流水' },
  { id: 'diagnostics', label: '诊断' },
]

export default function AdminPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <PanelShell open={open} onClose={onClose} title="管理面板">
      <div className="flex gap-1 overflow-x-auto border-b border-[hsl(var(--border))] px-6">
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
        {tab === 'settings' && <TeamSettings />}
        {tab === 'reverseAuth' && <ReverseAuth />}
        {tab === 'invites' && <InviteManager />}
        {tab === 'events' && <EventLog />}
        {tab === 'diagnostics' && <Diagnostics />}
      </div>
    </PanelShell>
  )
}
