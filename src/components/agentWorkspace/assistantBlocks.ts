import type { AgentRound, ResponsesOutputItem, TaskRecord } from '../../types'
import { collectWebSearchCalls, getAgentRoundOutputItems, getWebSearchStatusForCalls, type AgentWebSearchStatus } from '../../lib/agentWebSearch'

const AGENT_STOPPED_MESSAGE = '已停止生成。'

export type AgentAssistantBlock =
  | { type: 'web-search'; status: AgentWebSearchStatus; key: string }
  | { type: 'batch-params'; status: AgentWebSearchStatus; key: string }
  | { type: 'image-task'; task: TaskRecord; key: string }
  | { type: 'deleted-image-task'; taskId: string; key: string }
  | { type: 'text'; key: string; content?: string }

export interface AgentRoundTaskSlot {
  taskId: string
  task: TaskRecord | null
}

export function isAgentRoundInterrupted(round: AgentRound | null) {
  return round?.status === 'error' && round.error === AGENT_STOPPED_MESSAGE
}

function markToolStatusStopped(status: AgentWebSearchStatus): AgentWebSearchStatus {
  if (status.completed) return status
  return { text: status.text.replace(/^正在/, '已停止'), completed: true }
}

function getImageTaskForOutputItem(item: ResponsesOutputItem, tasksForRound: TaskRecord[]) {
  if (item.type !== 'image_generation_call') return null
  return tasksForRound.find((task) => task.agentToolCallId && task.agentToolCallId === item.id) ?? null
}

function getBatchImageTasksForOutputItem(item: ResponsesOutputItem, tasksForRound: TaskRecord[]) {
  if (item.type !== 'function_call' || item.name !== 'generate_image_batch' || !item.call_id) return []
  return tasksForRound.filter((task) => task.agentBatchCallId === item.call_id)
}

function getTextFromOutputItem(item: ResponsesOutputItem) {
  if (item.type !== 'message') return ''
  return (item.content ?? [])
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function getRoundTasks(round: AgentRound | null, tasks: TaskRecord[]) {
  if (!round) return []
  return round.outputTaskIds.map((taskId) => tasks.find((task) => task.id === taskId) ?? null)
}

export function getRoundTaskSlots(round: AgentRound | null, tasks: TaskRecord[]): AgentRoundTaskSlot[] {
  if (!round) return []
  return round.outputTaskIds.map((taskId) => ({
    taskId,
    task: tasks.find((task) => task.id === taskId) ?? null,
  }))
}

export function getAgentAssistantBlocks(round: AgentRound | null, taskSlots: AgentRoundTaskSlot[], allTasks: TaskRecord[], hasText: boolean): AgentAssistantBlock[] {
  const outputItems = getAgentRoundOutputItems(round, allTasks)
  const tasksForRound = taskSlots.map((slot) => slot.task).filter(Boolean) as TaskRecord[]
  const roundInterrupted = isAgentRoundInterrupted(round)
  if (outputItems.length === 0) {
    return [
      ...(hasText ? [{ type: 'text' as const, key: 'text:fallback' }] : []),
      ...taskSlots.map((slot) => slot.task
        ? ({ type: 'image-task' as const, task: slot.task, key: `image:${slot.task.id}` })
        : ({ type: 'deleted-image-task' as const, taskId: slot.taskId, key: `deleted-image:${slot.taskId}` }),
      ),
    ]
  }

  const blocks: AgentAssistantBlock[] = []
  const renderedTaskIds = new Set<string>()
  let renderedTextBlocks = 0
  let webSearchGroup: ResponsesOutputItem[] = []

  const flushWebSearchGroup = () => {
    if (webSearchGroup.length === 0) return
    const status = getWebSearchStatusForCalls(collectWebSearchCalls(webSearchGroup))
    if (status) blocks.push({ type: 'web-search', status: roundInterrupted ? markToolStatusStopped(status) : status, key: `web-search:${blocks.length}:${webSearchGroup.map((item) => item.id).join(':')}` })
    webSearchGroup = []
  }

  for (const item of outputItems) {
    if (item.type === 'web_search_call') {
      webSearchGroup.push(item)
      continue
    }

    flushWebSearchGroup()

    const imageTask = getImageTaskForOutputItem(item, tasksForRound)
    if (imageTask && !renderedTaskIds.has(imageTask.id)) {
      renderedTaskIds.add(imageTask.id)
      blocks.push({ type: 'image-task', task: imageTask, key: `image:${imageTask.id}` })
      continue
    }

    const batchImageTasks = getBatchImageTasksForOutputItem(item, tasksForRound)
    if (batchImageTasks.length > 0) {
      for (const task of batchImageTasks) {
        if (renderedTaskIds.has(task.id)) continue
        renderedTaskIds.add(task.id)
        blocks.push({ type: 'image-task', task, key: `image:${task.id}` })
      }
      continue
    }

    if ((round?.status === 'running' || roundInterrupted) && item.type === 'function_call' && item.name === 'generate_image_batch') {
      blocks.push({
        type: 'batch-params',
        status: roundInterrupted
          ? markToolStatusStopped({ text: '正在填写并发图像生成参数', completed: false })
          : { text: '正在填写并发图像生成参数', completed: false },
        key: `batch-params:${item.call_id ?? item.id ?? blocks.length}`,
      })
      continue
    }

    if (item.type === 'message') {
      const content = getTextFromOutputItem(item)
      if (content) {
        renderedTextBlocks += 1
        blocks.push({ type: 'text', key: `text:${item.id ?? blocks.length}`, content })
      }
    }
  }

  flushWebSearchGroup()

  if (hasText && renderedTextBlocks === 0) blocks.push({ type: 'text', key: 'text:fallback' })
  for (const slot of taskSlots) {
    if (slot.task) {
      if (!renderedTaskIds.has(slot.task.id)) blocks.push({ type: 'image-task', task: slot.task, key: `image:${slot.task.id}` })
    } else {
      blocks.push({ type: 'deleted-image-task', taskId: slot.taskId, key: `deleted-image:${slot.taskId}` })
    }
  }
  return blocks
}

export function getAgentAssistantCopyContent(fallbackContent: string, blocks: AgentAssistantBlock[]) {
  if (!blocks.some((block) => block.type !== 'text')) return fallbackContent

  const parts = blocks
    .filter((block): block is Extract<AgentAssistantBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.content ?? '')
    .map((content) => content.trim())
    .filter(Boolean)

  return parts.length > 0 ? parts.join('\n\n') : fallbackContent
}

export function getRoundStatusLabel(round: AgentRound | null) {
  if (!round) return null
  if (round.status === 'running') return '生成中'
  if (round.status === 'error') return isAgentRoundInterrupted(round) ? '已停止' : '失败'
  return '已完成'
}
