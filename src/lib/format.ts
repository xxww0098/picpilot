export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

/** 短耗时，适合单次请求平均耗时 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (!ms) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 长耗时，适合用户累计统计 */
export function formatDurationLong(ms: number | null | undefined): string {
  if (!ms) return '0'
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}min`
  return `${(min / 60).toFixed(1)}h`
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  return new Date(ts).toLocaleDateString()
}

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export function formatOptionalExpiry(ts: number | null | undefined): string {
  if (!ts) return '永久'
  return new Date(ts).toLocaleString()
}
