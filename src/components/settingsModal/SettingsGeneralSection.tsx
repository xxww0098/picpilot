import { type ReactNode } from 'react'
import Select from '../ui/Select'
import type { AppSettings } from '../../types'

// 「习惯配置」设置页：纯展示 + 通过 commitSettings 写回，无私有状态。
// 按「输入与提交 / 任务与生成 / Agent 交互」分组为卡片，每组带配色图标头，
// 开关行整行可点、附说明，视觉与「关于 / 数据管理」页统一。
export default function SettingsGeneralSection({
  draft,
  commitSettings,
}: {
  draft: AppSettings
  commitSettings: (next: AppSettings) => void
}) {
  const toggle = (key: keyof AppSettings) => commitSettings({ ...draft, [key]: !draft[key] })

  const selectClass =
    'w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none'

  return (
    <div className="space-y-4">
      <Card
        title="输入与提交"
        subtitle="提示词输入框与任务提交行为"
        accent="bg-blue-500/10 text-blue-600 dark:text-blue-400"
        icon={
          <IconSvg>
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h10" />
          </IconSvg>
        }
      >
        <ToggleRow
          label="提交任务后清空输入框"
          desc="提交成功创建任务时，自动清空提示词和参考图。"
          checked={draft.clearInputAfterSubmit}
          onToggle={() => toggle('clearInputAfterSubmit')}
        />
        <ToggleRow
          label="重启后加载上次的输入框"
          desc="关闭后不再持久化提示词和参考图，下次启动使用空输入框。"
          checked={draft.persistInputOnRestart}
          onToggle={() => toggle('persistInputOnRestart')}
        />
        {/* 桌面端专属：移动端虚拟键盘无 Enter / 修饰键之分，故隐藏。放在末位避免分隔线错位。 */}
        <SelectRow
          className="hidden sm:flex"
          label="任务提交方式"
          desc="选 Enter 提交时用 Shift + Enter 换行；否则直接 Enter 换行。"
        >
          <Select
            value={draft.enterSubmit ? 'enter' : 'ctrl-enter'}
            onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
            options={[
              { label: 'Enter', value: 'enter' },
              { label: navigator.userAgent.includes('Mac') ? 'Cmd + Enter' : 'Ctrl + Enter', value: 'ctrl-enter' },
            ]}
            className={selectClass}
          />
        </SelectRow>
      </Card>

      <Card
        title="任务与生成"
        subtitle="参考图、配置复用与重试"
        accent="bg-violet-500/10 text-violet-600 dark:text-violet-400"
        icon={
          <IconSvg>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </IconSvg>
        }
      >
        <SelectRow
          label="参考图编辑按钮"
          desc="未加遮罩的参考图点击编辑时，是每次询问、直接替换，还是直接加遮罩。"
        >
          <Select
            value={draft.referenceImageEditAction}
            onChange={(val) => commitSettings({ ...draft, referenceImageEditAction: val as AppSettings['referenceImageEditAction'] })}
            options={[
              { label: '询问', value: 'ask' },
              { label: '替换参考图', value: 'replace-reference' },
              { label: '添加遮罩', value: 'add-mask' },
            ]}
            className={selectClass}
          />
        </SelectRow>
        <ToggleRow
          label="复用历史任务时使用原 API 与模型配置"
          desc="复用历史任务时优先用当时的配置；若已删除，提交前询问是否改用当前配置。"
          checked={draft.reuseTaskApiProfileTemporarily}
          onToggle={() => toggle('reuseTaskApiProfileTemporarily')}
        />
        <ToggleRow
          label="成功任务也显示重试按钮"
          desc="已成功的任务卡片与详情页也显示重试，方便用相同参数再生成一次。"
          checked={draft.alwaysShowRetryButton}
          onToggle={() => toggle('alwaysShowRetryButton')}
        />
      </Card>

      <Card
        title="Agent 交互"
        subtitle="Agent 模式下的交互细节"
        accent="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        icon={
          <IconSvg>
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
          </IconSvg>
        }
      >
        <ToggleRow
          label="发送消息后自动滚动到底部"
          desc="Agent 模式发送消息成功后，自动滚动到对话底部。"
          checked={draft.agentScrollToBottomAfterSubmit}
          onToggle={() => toggle('agentScrollToBottomAfterSubmit')}
        />
      </Card>
    </div>
  )
}

function IconSvg({ children }: { children: ReactNode }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

function Card({
  title,
  subtitle,
  accent,
  icon,
  children,
}: {
  title: string
  subtitle: string
  accent: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-white/[0.06] dark:bg-white/[0.02]">
      <header className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3 dark:border-white/[0.06]">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${accent}`}>{icon}</span>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h4>
          <p className="truncate text-xs text-gray-400 dark:text-gray-500">{subtitle}</p>
        </div>
      </header>
      <div className="divide-y divide-gray-100 dark:divide-white/[0.05]">{children}</div>
    </section>
  )
}

function ToggleRow({ label, desc, checked, onToggle }: { label: string; desc: string; checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-gray-50/70 dark:hover:bg-white/[0.02]"
    >
      <span className="min-w-0">
        <span className="block text-sm text-gray-700 dark:text-gray-200">{label}</span>
        <span data-selectable-text className="mt-0.5 block text-xs leading-relaxed text-gray-400 dark:text-gray-500">{desc}</span>
      </span>
      <Switch checked={checked} />
    </button>
  )
}

function SelectRow({ label, desc, children, className = '' }: { label: string; desc: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 ${className}`}>
      <span className="min-w-0">
        <span className="block text-sm text-gray-700 dark:text-gray-200">{label}</span>
        <span data-selectable-text className="mt-0.5 block text-xs leading-relaxed text-gray-400 dark:text-gray-500">{desc}</span>
      </span>
      <div className="w-32 shrink-0">{children}</div>
    </div>
  )
}

// 纯展示开关（交互由外层整行 ToggleRow 的 button 承载，故此处不可聚焦）。
function Switch({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </span>
  )
}
