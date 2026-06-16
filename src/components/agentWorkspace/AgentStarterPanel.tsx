import type { AgentPlatformStarterPrompt } from '../../lib/platforms/types'
import { WrenchIcon } from '../ui/icons'

export default function AgentStarterPanel({
  label,
  title,
  description,
  starterPrompts,
  onApplyPrompt,
}: {
  label: string
  title: string
  description: string
  starterPrompts: readonly AgentPlatformStarterPrompt[]
  onApplyPrompt: (prompt: string, targetAssetSlotId?: string) => void
}) {
  return (
    <div className="mx-auto flex min-h-[46vh] w-full max-w-3xl flex-col justify-start px-4 pb-[calc(var(--input-bar-clearance,12rem)+2rem)] pt-2 sm:pt-4 lg:pt-5">
      <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
        <WrenchIcon className="h-4 w-4 text-blue-500" />
        {label}
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {starterPrompts.map((starter) => (
          <button
            key={starter.id}
            type="button"
            onClick={() => onApplyPrompt(starter.prompt, starter.targetAssetSlotId)}
            className="min-h-[4.5rem] rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10"
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">{starter.title}</span>
            <span className="mt-1 block truncate text-xs leading-5 text-gray-500 dark:text-gray-400">{starter.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
