import type { AgentPlatformId } from '../../types'
import { getEnabledAgentPlatforms } from '../../lib/platforms/registry'

export default function AgentPlatformPicker({
  onSelectPlatform,
}: {
  onSelectPlatform: (platformId: AgentPlatformId) => void
}) {
  const platforms = getEnabledAgentPlatforms()

  return (
    <div className="mx-auto flex min-h-[46vh] w-full max-w-3xl flex-col justify-start px-4 pb-[calc(var(--input-bar-clearance,12rem)+2rem)] pt-2 sm:pt-4 lg:pt-5">
      <div className="mb-5 inline-flex w-fit items-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
        选择平台
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">先确定素材用途</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
        Agent 会按平台规则组织提示词、素材槽位和候选图状态。第一版开放 Ozon 和独立站项目。
      </p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {platforms.map((platform) => (
          <button
            key={platform.id}
            type="button"
            onClick={() => onSelectPlatform(platform.id)}
            className="min-h-[5.75rem] rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10"
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">{platform.label}</span>
            <span className="mt-1.5 block text-xs leading-5 text-gray-500 dark:text-gray-400">{platform.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
