import type { AgentAssetStatus, AgentConversation, TaskRecord } from '../../types'
import { getAgentPlatformAssetSlot, getAgentPlatformDefinition } from '../../lib/platforms/registry'
import { PhotoIcon } from '../ui/icons'

function getTaskAssetStatus(task: TaskRecord): AgentAssetStatus {
  return task.assetStatus ?? 'candidate'
}

function getTaskStatusLabel(task: TaskRecord) {
  if (task.status === 'running') return '生成中'
  if (task.status === 'error') return '失败'
  return '完成'
}

function getPlanStatusLabel(status: NonNullable<AgentConversation['assetPlan']>[number]['status']) {
  if (status === 'generating') return '生成中'
  if (status === 'ready') return '已就绪'
  if (status === 'needs_revision') return '需调整'
  return '计划中'
}

function getStatusButtonClass(active: boolean, tone: 'neutral' | 'blue') {
  if (tone === 'blue') {
    return active
      ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300'
      : 'border-gray-200 bg-white text-gray-500 hover:border-blue-200 hover:bg-blue-50/50 hover:text-blue-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-400 dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10 dark:hover:text-blue-300'
  }
  return active
    ? 'border-gray-300 bg-gray-100 text-gray-700 dark:border-white/[0.16] dark:bg-white/[0.08] dark:text-gray-200'
    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-800 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-white'
}

export default function AgentAssetPlanPanel({
  conversation,
  tasks,
  onSetTaskAssetStatus,
}: {
  conversation: AgentConversation
  tasks: TaskRecord[]
  onSetTaskAssetStatus: (taskId: string, nextStatus: AgentAssetStatus) => void
}) {
  const platform = getAgentPlatformDefinition(conversation.platformId)
  if (!platform?.enabled || !conversation.assetPlan?.length) return null

  return (
    <div className="mx-1 mt-3 rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-white/[0.08] dark:bg-white/[0.03] lg:mx-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">素材槽位</div>
          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{platform.label} 项目候选管理</div>
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
        {conversation.assetPlan.map((item) => {
          const plannedTaskIds = new Set(item.taskIds)
          const slot = getAgentPlatformAssetSlot(platform.id, item.slotId)
          const slotTasks = tasks
            .filter((task) => {
              if (plannedTaskIds.has(task.id)) return true
              return task.agentConversationId === conversation.id &&
                task.platformId === platform.id &&
                task.platformAssetSlotId === item.slotId
            })
            .sort((a, b) => b.createdAt - a.createdAt)
          const approvedCount = slotTasks.filter((task) => getTaskAssetStatus(task) === 'approved').length
          const candidateCount = slotTasks.filter((task) => getTaskAssetStatus(task) === 'candidate').length
          const rejectedCount = slotTasks.filter((task) => getTaskAssetStatus(task) === 'rejected').length

          return (
            <div key={item.slotId} className="py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{slot?.label ?? item.slotId}</span>
                    {slot?.required && (
                      <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">必需</span>
                    )}
                    <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                      {getPlanStatusLabel(item.status)}
                    </span>
                  </div>
                  {slot?.description && (
                    <div className="mt-1 max-w-2xl text-xs leading-5 text-gray-500 dark:text-gray-400">{slot.description}</div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                  <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-1 dark:bg-white/[0.06]">
                    <PhotoIcon className="h-3.5 w-3.5" />
                    {slotTasks.length} 任务
                  </span>
                  <span className="rounded-md bg-gray-100 px-1.5 py-1 dark:bg-white/[0.06]">候选 {candidateCount}</span>
                  <span className="rounded-md bg-blue-50 px-1.5 py-1 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">已通过 {approvedCount}</span>
                  {rejectedCount > 0 && (
                    <span className="rounded-md bg-gray-100 px-1.5 py-1 dark:bg-white/[0.06]">已替换 {rejectedCount}</span>
                  )}
                </div>
              </div>
              {slotTasks.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {slotTasks.map((task) => {
                    const status = getTaskAssetStatus(task)
                    const isApproved = status === 'approved'
                    const isCandidate = status === 'candidate'
                    const canApprove = task.status === 'done' && task.outputImages.length > 0
                    const approvalDisabled = !isApproved && !canApprove
                    return (
                      <div key={task.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-2.5 py-2 dark:bg-white/[0.035]">
                        <div className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
                          <span className="font-medium text-gray-700 dark:text-gray-200">任务 {task.id.slice(0, 8)}</span>
                          <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>
                          <span>{task.outputImages.length} 张图</span>
                          <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>
                          <span>{getTaskStatusLabel(task)}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSetTaskAssetStatus(task.id, 'candidate')}
                            disabled={isCandidate}
                            className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-default ${getStatusButtonClass(isCandidate, 'neutral')}`}
                          >
                            候选
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (isApproved) {
                                onSetTaskAssetStatus(task.id, 'candidate')
                                return
                              }
                              if (canApprove) onSetTaskAssetStatus(task.id, 'approved')
                            }}
                            disabled={approvalDisabled}
                            className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${getStatusButtonClass(isApproved, 'blue')}`}
                          >
                            {isApproved ? '已通过' : '通过'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
