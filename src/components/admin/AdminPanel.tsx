import { useState, type ReactElement, type SVGProps } from 'react'
import PanelShell from '../ui/PanelShell'
import Button from '../ui/Button'
import { cn } from '../../lib/utils'
import {
  ActivityIcon,
  HistoryIcon,
  MailIcon,
  SettingsIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
} from '../ui/icons'
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

type TabIcon = (props: SVGProps<SVGSVGElement>) => ReactElement

const TABS: Array<{ id: Tab; label: string; icon: TabIcon }> = [
  { id: 'overview', label: '概览', icon: ActivityIcon },
  { id: 'users', label: '用户', icon: UsersIcon },
  { id: 'settings', label: '默认配置', icon: SettingsIcon },
  { id: 'reverseAuth', label: '逆向账号', icon: TerminalIcon },
  { id: 'invites', label: '邀请码', icon: MailIcon },
  { id: 'events', label: '事件流水', icon: HistoryIcon },
  { id: 'diagnostics', label: '诊断', icon: WrenchIcon },
]

export default function AdminPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <PanelShell open={open} onClose={onClose} title="管理面板" subtitle="用户、配置、逆向账号与请求日志">
      <nav
        aria-label="管理面板分区"
        className="flex gap-1 overflow-x-auto border-b border-[hsl(var(--border))] px-4 py-2 [scrollbar-width:thin]"
      >
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <Button
              key={t.id}
              type="button"
              variant="ghost"
              onClick={() => setTab(t.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group shrink-0 rounded-lg px-3 py-1.5',
                active
                  ? 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary)/0.12)]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 transition-colors',
                  !active && 'text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--foreground))]',
                )}
              />
              {t.label}
            </Button>
          )
        })}
      </nav>
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
