import { describe, expect, it } from 'vitest'
import { getConversationTimeBucket, groupConversationsByTime } from './agentConversationGroups'
import type { AgentConversation } from '../types'

// 固定"现在"为周三中午,便于推算本周/更早边界。
const NOW = new Date(2026, 5, 10, 12, 0, 0) // 2026-06-10 (Wed)
const DAY = 24 * 60 * 60 * 1000

function conv(id: string, updatedAt: number): AgentConversation {
  return { id, title: id, createdAt: updatedAt, updatedAt, rounds: [], messages: [] }
}

describe('getConversationTimeBucket', () => {
  it('buckets by today/yesterday/this-week/older', () => {
    const t = NOW.getTime()
    expect(getConversationTimeBucket(t, NOW)).toBe('今天')
    expect(getConversationTimeBucket(t - DAY, NOW)).toBe('昨天')
    expect(getConversationTimeBucket(t - 2 * DAY, NOW)).toBe('本周') // Mon, same week
    expect(getConversationTimeBucket(t - 7 * DAY, NOW)).toBe('更早')
  })
})

describe('groupConversationsByTime', () => {
  it('groups, orders buckets, and sorts items desc within a bucket', () => {
    const t = NOW.getTime()
    const groups = groupConversationsByTime(
      [conv('older', t - 10 * DAY), conv('today-1', t - 1000), conv('today-2', t - 500), conv('yest', t - DAY)],
      NOW,
    )
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '更早'])
    expect(groups[0].items.map((c) => c.id)).toEqual(['today-2', 'today-1']) // desc
  })

  it('returns empty array for no conversations', () => {
    expect(groupConversationsByTime([], NOW)).toEqual([])
  })
})
