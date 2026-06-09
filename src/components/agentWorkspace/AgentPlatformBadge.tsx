import type { AgentPlatformId } from '../../types'
import { getAgentPlatformDefinition } from '../../lib/platforms/registry'

export default function AgentPlatformBadge({
  platformId,
  className = '',
}: {
  platformId?: AgentPlatformId | string | null
  className?: string
}) {
  const platform = getAgentPlatformDefinition(platformId)
  const label = platform?.shortLabel || '旧对话'

  return (
    <span className={`inline-flex h-5 shrink-0 items-center rounded-md border border-gray-200 bg-white px-1.5 text-[11px] font-medium text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-400 ${className}`}>
      {label}
    </span>
  )
}
