// 运行时配置：环境变量派生常量、日志器、启动校验与目录初始化。
// 从 server/index.ts 抽出，作为其余模块（db / 各 helper / 各路由）的共享基础，单向被依赖。
import pino from 'pino'
import path from 'path'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  normalizeBatchImageLimit,
  normalizeBooleanSetting,
  normalizeGalleryAutoRetryCount,
  normalizeProxyUserSoftLimit,
  normalizeRequestTimeoutSeconds,
} from './utils/validation.ts'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'picpilot', component: 'hono-server' },
  transport: process.env.LOG_PRETTY === '1'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,app,component',
          messageFormat: '[{component}] {msg}',
        },
      }
    : undefined,
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PORT = Number(process.env.AUTH_PORT ?? '3001')
export const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : path.resolve(__dirname, '../dist')
// 访问令牌有效期：短时（默认 2h）。前端在过期前静默刷新（/api/auth/refresh），
// 因此泄露但未刷新的令牌最多 2h 后失效，大幅缩小被盗窗口。
export const JWT_EXPIRES_IN_SECONDS = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 2 * 60 * 60)
// 会话绝对上限（默认 7d）：从登录那一刻起算，超过即使一直刷新也必须重新登录。
// 给被持续刷新的被盗令牌设一个硬上限。
export const JWT_SESSION_MAX_SECONDS = Number(process.env.JWT_SESSION_MAX_SECONDS ?? 7 * 24 * 60 * 60)
export const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../data')
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'auth.db')
export const PUBLIC_DIR = path.join(DATA_DIR, 'public')
export const THUMBS_DIR = path.join(PUBLIC_DIR, 'thumbs')
export const AVATARS_DIR = path.join(DATA_DIR, 'avatars')
export const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS ?? 30)
export const PER_USER_PUBLIC_QUOTA_BYTES = Number(process.env.PER_USER_PUBLIC_QUOTA_BYTES ?? 500 * 1024 * 1024)
export const API_PROXY_URL = (process.env.API_PROXY_URL || '').trim()
export const API_PROXY_API_KEY = (process.env.API_PROXY_API_KEY || '').trim()
export const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_PROXY_REQUESTS ?? 5))
// 排队等待上限：超过 MAX_CONCURRENT 的请求进入 FIFO 队列等待放行。
// 等待期间连接静默无字节流动，必须 < Bun idleTimeout(255s)，否则会被静默断开；这里钳到 240s 内。
export const PROXY_QUEUE_MAX_WAIT_MS = Math.min(240_000, Math.max(0, Number(process.env.PROXY_QUEUE_MAX_WAIT_MS ?? 240_000)))
// 队列长度上限：已满时新请求立即 429，避免无限堆积。
export const PROXY_QUEUE_MAX = Math.max(0, Number(process.env.PROXY_QUEUE_MAX ?? 10))
export const PROXY_USER_SOFT_LIMIT = normalizeProxyUserSoftLimit(process.env.PROXY_USER_SOFT_LIMIT, 3)
export const DEFAULT_MAX_BATCH_IMAGES = normalizeBatchImageLimit(process.env.DEFAULT_MAX_BATCH_IMAGES, 10)
export const DEFAULT_GALLERY_AUTO_RETRY_COUNT = normalizeGalleryAutoRetryCount(process.env.DEFAULT_GALLERY_AUTO_RETRY_COUNT, 1)
export const DEFAULT_STREAM_FALLBACK_ENABLED = normalizeBooleanSetting(process.env.STREAM_FALLBACK_ENABLED, true)
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = normalizeRequestTimeoutSeconds(process.env.REQUEST_TIMEOUT_SECONDS, 900)
export const CLIPROXY_LOG_DIR = (process.env.CLIPROXY_LOG_DIR || '').trim()
export const MAX_IMAGE_LONG_EDGE = 2048
export const THUMB_LONG_EDGE = 256
export const AVATAR_SIZE = 256
export const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024
// 邀请码生成上限（管理端批量生成）
export const INVITE_MAX_USES = 1000
export const INVITE_MAX_BATCH_COUNT = 50
export const INVITE_NOTE_MAX_LEN = 200
export const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

// 启动校验（缺失/过短的 JWT_SECRET 立即退出）。在模块导入时执行一次。
const JWT_SECRET_RAW = process.env.JWT_SECRET
if (!JWT_SECRET_RAW) {
  logger.fatal({ scope: 'auth' }, 'JWT_SECRET environment variable is required')
  process.exit(1)
}
if (JWT_SECRET_RAW.length < 32) {
  logger.fatal({ scope: 'auth' }, 'JWT_SECRET must be at least 32 characters for security')
  process.exit(1)
}
export const JWT_SECRET: string = JWT_SECRET_RAW

// 必需目录初始化（导入时执行一次）。
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(PUBLIC_DIR, { recursive: true })
mkdirSync(THUMBS_DIR, { recursive: true })
mkdirSync(AVATARS_DIR, { recursive: true })
