import type { AgentConversation } from '../types'

// 会话按更新时间分组(ChatGPT 风格:今天 / 昨天 / 本周 / 更早)。
// 纯函数,便于单测;与 HistoryModal 的分桶口径保持一致。

const DAY = 24 * 60 * 60 * 1000
const BUCKET_ORDER = ['今天', '昨天', '本周', '更早'] as const

export function getConversationTimeBucket(value: number, now: Date = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - DAY
  const dayOfWeek = now.getDay() || 7
  const startOfWeek = startOfToday - (dayOfWeek - 1) * DAY
  if (value >= startOfToday) return '今天'
  if (value >= startOfYesterday) return '昨天'
  if (value >= startOfWeek) return '本周'
  return '更早'
}

export type ConversationGroup = { label: string; items: AgentConversation[] }

/** 按更新时间倒序分组;空桶不出现,桶顺序固定。 */
export function groupConversationsByTime(conversations: AgentConversation[], now: Date = new Date()): ConversationGroup[] {
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  const map = new Map<string, AgentConversation[]>()
  for (const c of sorted) {
    const label = getConversationTimeBucket(c.updatedAt, now)
    const bucket = map.get(label)
    if (bucket) bucket.push(c)
    else map.set(label, [c])
  }
  return BUCKET_ORDER.filter((l) => map.has(l)).map((label) => ({ label, items: map.get(label) ?? [] }))
}
