// 从 server/index.ts 抽出的纯校验/归一化辅助函数（无状态、无副作用，便于复用与测试）。

export function normalizeBatchImageLimit(value: unknown, fallback = 4): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(100, Math.trunc(numeric)))
}

export function parseBatchImageLimitPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 100) return null
  return Math.trunc(numeric)
}

export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 12; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

export function getPositiveIntegerValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(numeric)) return null
  return Math.max(1, Math.min(1000, Math.trunc(numeric)))
}
