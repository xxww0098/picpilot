import type { AgentConversation, AgentPlatformAssetPlanItem, AgentPlatformId, AgentRound, TaskRecord } from '../../types'
import { getAgentPlatformAssetSlot, getAgentPlatformDefinition } from '../platforms/registry'

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (Array.isArray(item)) return item.length > 0
    return item != null && item !== ''
  }))
}

export function getValidAgentTargetAssetSlotId(platformId: AgentPlatformId | null | undefined, slotId: string | null | undefined) {
  return getAgentPlatformAssetSlot(platformId, slotId)?.id ?? null
}

export function addTaskToAgentAssetPlan(
  assetPlan: AgentPlatformAssetPlanItem[] | undefined,
  slotId: string | null | undefined,
  taskId: string,
): AgentPlatformAssetPlanItem[] | undefined {
  if (!slotId) return assetPlan

  if (!assetPlan) {
    return [{
      slotId,
      status: 'generating',
      taskIds: [taskId],
    }]
  }

  const slotIndex = assetPlan.findIndex((item) => item.slotId === slotId)
  if (slotIndex === -1) {
    return [
      ...assetPlan,
      {
        slotId,
        status: 'generating',
        taskIds: [taskId],
      },
    ]
  }

  return assetPlan.map((item, index) => {
    if (index !== slotIndex) return item
    return {
      ...item,
      status: 'generating',
      taskIds: item.taskIds.includes(taskId) ? item.taskIds : [...item.taskIds, taskId],
    }
  })
}

export function resolveSuccessfulPlatformTaskIds(tasks: TaskRecord[]): Set<string> {
  return new Set(tasks
    .filter((task) => task.status === 'done' && task.outputImages.length > 0)
    .map((task) => task.id))
}

function getAssetPlanItemTaskIds(item: AgentPlatformAssetPlanItem) {
  return Array.from(new Set([
    ...item.taskIds,
    ...(item.approvedTaskId ? [item.approvedTaskId] : []),
  ]))
}

export function reconcileAgentAssetPlanWithTasks(
  assetPlan: AgentPlatformAssetPlanItem[] | undefined,
  tasks: TaskRecord[],
): AgentPlatformAssetPlanItem[] | undefined {
  if (!assetPlan) return assetPlan

  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  return assetPlan.map((item) => {
    const retainedTaskIds = item.taskIds.filter((taskId) => tasksById.has(taskId))
    const approvedTaskId = item.approvedTaskId && tasksById.has(item.approvedTaskId)
      ? item.approvedTaskId
      : undefined
    const relevantTasks = getAssetPlanItemTaskIds({ ...item, taskIds: retainedTaskIds, approvedTaskId })
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is TaskRecord => Boolean(task))
    const status = relevantTasks.some((task) => task.status === 'done' && task.outputImages.length > 0)
      ? 'ready'
      : relevantTasks.some((task) => task.status === 'running')
      ? 'generating'
      : relevantTasks.length > 0
      ? 'needs_revision'
      : 'planned'
    const { approvedTaskId: _removedApprovedTaskId, ...rest } = item

    return {
      ...rest,
      status,
      taskIds: retainedTaskIds,
      ...(approvedTaskId ? { approvedTaskId } : {}),
    }
  })
}

export function finalizeAgentAssetPlanSlotStatus(
  assetPlan: AgentPlatformAssetPlanItem[] | undefined,
  slotId: string | null | undefined,
  tasks: TaskRecord[],
): AgentPlatformAssetPlanItem[] | undefined {
  if (!slotId || !assetPlan) return assetPlan

  const successfulTaskIds = resolveSuccessfulPlatformTaskIds(tasks)
  return assetPlan.map((item) => {
    if (item.slotId !== slotId || item.taskIds.length === 0) return item
    return {
      ...item,
      status: item.taskIds.some((taskId) => successfulTaskIds.has(taskId)) ? 'ready' : 'needs_revision',
    }
  })
}

export function buildAgentPlatformContextItem(conversation: AgentConversation, round: AgentRound, tasks: TaskRecord[]): Record<string, unknown> | null {
  const platform = getAgentPlatformDefinition(conversation.platformId)
  if (!platform?.enabled) return null
  const targetSlotId = getValidAgentTargetAssetSlotId(platform.id, round.targetAssetSlotId)
  const targetSlot = getAgentPlatformAssetSlot(platform.id, targetSlotId)
  const platformTasks = tasks
    .filter((task) => task.agentConversationId === conversation.id && task.platformId === platform.id)
    .map((task) => compactObject({
      id: task.id,
      slotId: task.platformAssetSlotId,
      status: task.assetStatus,
      prompt: task.prompt,
      outputCount: task.outputImages.length,
    }))

  return {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: [
          '<platform_context>',
          `Platform: ${platform.label}`,
          `Platform ID: ${platform.id}`,
          conversation.platformBrief ? `Brief: ${JSON.stringify(conversation.platformBrief)}` : '',
          conversation.assetPlan ? `Asset plan: ${JSON.stringify(conversation.assetPlan)}` : '',
          targetSlot ? `Current target slot: ${targetSlot.id} (${targetSlot.label})` : '',
          platformTasks.length ? `Existing platform tasks: ${JSON.stringify(platformTasks)}` : '',
          '</platform_context>',
        ].filter(Boolean).join('\n'),
      },
    ],
  }
}

export function withAgentPlatformTaskMetadata<T extends TaskRecord>(task: T, conversation: AgentConversation, round: AgentRound): T {
  const platform = getAgentPlatformDefinition(conversation.platformId)
  const targetAssetSlotId = getValidAgentTargetAssetSlotId(platform?.id, round.targetAssetSlotId)
  if (!platform?.enabled || !targetAssetSlotId) return task
  return {
    ...task,
    platformId: platform.id,
    platformAssetSlotId: targetAssetSlotId,
    assetStatus: task.assetStatus ?? 'candidate',
  }
}
