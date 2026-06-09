import type { AgentPlatformId } from '../../types'
import type { AgentPlatformDefinition } from '../../lib/platforms/types'
import AgentPlatformPicker from './AgentPlatformPicker'
import AgentStarterPanel from './AgentStarterPanel'

export default function AgentWorkspaceEmptyState({
  platformDefinition,
  onSelectPlatform,
  onApplyPrompt,
}: {
  platformDefinition: AgentPlatformDefinition | null
  onSelectPlatform: (platformId: AgentPlatformId) => void
  onApplyPrompt: (prompt: string, targetAssetSlotId?: string) => void
}) {
  if (!platformDefinition) {
    return <AgentPlatformPicker onSelectPlatform={onSelectPlatform} />
  }

  return (
    <AgentStarterPanel
      label={platformDefinition.label}
      title={`${platformDefinition.label} 素材项目`}
      description={platformDefinition.description}
      starterPrompts={platformDefinition.starterPrompts}
      onApplyPrompt={onApplyPrompt}
    />
  )
}
