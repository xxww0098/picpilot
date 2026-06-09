import type { AgentConversation, TaskRecord } from '../../types'
import { getAgentPlatformDefinition } from '../../lib/platforms/registry'

export function getConversationSearchText(conversation: AgentConversation) {
  const platform = getAgentPlatformDefinition(conversation.platformId)
  return [
    conversation.title,
    platform?.label,
    platform?.shortLabel,
    ...conversation.messages.map((message) => message.content),
    ...conversation.rounds.map((round) => round.prompt),
  ].filter(Boolean).join('\n').toLocaleLowerCase()
}

export function getConversationOutputTaskIds(conversation: AgentConversation | null) {
  if (!conversation) return []
  return Array.from(new Set(conversation.rounds.flatMap((round) => round.outputTaskIds)))
}

export function getConversationGeneratedImageCount(conversation: AgentConversation | null, tasks: TaskRecord[]) {
  const taskIds = new Set(getConversationOutputTaskIds(conversation))
  if (taskIds.size === 0) return 0
  return tasks
    .filter((task) => taskIds.has(task.id))
    .reduce((count, task) => count + (task.outputImages?.length ?? 0), 0)
}

export function getConversationAssetPlanProgress(conversation: AgentConversation | null, tasks: TaskRecord[] = []) {
  const platform = getAgentPlatformDefinition(conversation?.platformId)
  const assetPlan = conversation?.assetPlan
  if (!platform?.enabled || !assetPlan?.length) return ''

  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const filledSlots = assetPlan.filter((item) => {
    const plannedTaskIds = new Set([
      ...item.taskIds,
      ...(item.approvedTaskId ? [item.approvedTaskId] : []),
    ])
    const hasPlannedOutput = Array.from(plannedTaskIds).some((taskId) => {
      const task = tasksById.get(taskId)
      return task?.status === 'done' && task.outputImages.length > 0
    })
    if (hasPlannedOutput) return true
    return tasks.some((task) =>
      task.agentConversationId === conversation?.id &&
      task.platformId === platform.id &&
      task.platformAssetSlotId === item.slotId &&
      task.status === 'done' &&
      task.outputImages.length > 0
    )
  }).length
  return `${filledSlots}/${assetPlan.length} 槽位`
}
