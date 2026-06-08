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

// 团队并发上限：全局同时在途请求数。范围 1-100。
export function normalizeConcurrencyLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(100, Math.trunc(numeric)))
}

export function parseConcurrencyPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 100) return null
  return Math.trunc(numeric)
}

// 排队上限：等待队列长度。范围 0-1000（0 表示不排队，满载即 429）。
export function normalizeQueueLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(1000, Math.trunc(numeric)))
}

export function parseQueuePatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1000) return null
  return Math.trunc(numeric)
}

// 单用户软上限：0 表示关闭；>0 时，队首用户已占满该上限且后方有其他用户等待时，优先放行后方用户。
export function normalizeProxyUserSoftLimit(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(100, Math.trunc(numeric)))
}

export function parseProxyUserSoftLimitPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null
  return Math.trunc(numeric)
}

// 画廊批量卡片失败自动补重试次数。范围 0-5，0 表示关闭。
export function normalizeGalleryAutoRetryCount(value: unknown, fallback = 1): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(5, Math.trunc(numeric)))
}

export function parseGalleryAutoRetryCountPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 5) return null
  return Math.trunc(numeric)
}

export function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  return fallback
}

export function parseBooleanPatchValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return null
}

// 请求超时统一配置：图片、Agent、视频长轮询都可能超过 5 分钟，默认 900s；范围 30s-3600s。
export function normalizeRequestTimeoutSeconds(value: unknown, fallback = 900): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(30, Math.min(3600, Math.trunc(numeric)))
}

export function parseRequestTimeoutSecondsPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 30 || numeric > 3600) return null
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
