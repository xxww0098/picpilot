import type { AgentConversation, TaskRecord } from '../../types'

export function getConversationSearchText(conversation: AgentConversation) {
  return [
    conversation.title,
    ...conversation.messages.map((message) => message.content),
    ...conversation.rounds.map((round) => round.prompt),
  ].join('\n').toLocaleLowerCase()
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
