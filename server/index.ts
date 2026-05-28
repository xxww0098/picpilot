import { Hono, type Context, type Next } from 'hono'
import { jwt as jwtMiddleware, sign as jwtSign } from 'hono/jwt'
import { Database } from 'bun:sqlite'
import pino from 'pino'
import sharp from 'sharp'
import path from 'path'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { writeFile } from 'fs/promises'
import { fileURLToPath } from 'url'

const logger = pino({
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
const PORT = Number(process.env.AUTH_PORT ?? '3001')
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : path.resolve(__dirname, '../dist')
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN_SECONDS = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 30 * 24 * 60 * 60)
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../data')
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'auth.db')
const PUBLIC_DIR = path.join(DATA_DIR, 'public')
const THUMBS_DIR = path.join(PUBLIC_DIR, 'thumbs')
const AVATARS_DIR = path.join(DATA_DIR, 'avatars')
const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS ?? 30)
const PER_USER_PUBLIC_QUOTA_BYTES = Number(process.env.PER_USER_PUBLIC_QUOTA_BYTES ?? 500 * 1024 * 1024)
const API_PROXY_URL = (process.env.API_PROXY_URL || process.env.TEAM_API_BASE_URL || process.env.API_URL || '').trim()
const API_PROXY_API_KEY = (process.env.API_PROXY_API_KEY || process.env.TEAM_API_KEY || '').trim()
const DEFAULT_HOURLY_IMAGE_QUOTA = normalizeQuotaValue(process.env.DEFAULT_HOURLY_IMAGE_QUOTA ?? process.env.TEAM_HOURLY_IMAGE_QUOTA, 100)
const DEFAULT_MAX_BATCH_IMAGES = normalizeBatchImageLimit(process.env.DEFAULT_MAX_BATCH_IMAGES, 10)
const MAX_IMAGE_LONG_EDGE = 2048
const THUMB_LONG_EDGE = 256
const AVATAR_SIZE = 256
const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024
const HOUR_MS = 60 * 60 * 1000
const MIME_TYPES: Record<string, string> = {
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

if (!JWT_SECRET) {
  logger.fatal({ scope: 'auth' }, 'JWT_SECRET environment variable is required')
  process.exit(1)
}

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(PUBLIC_DIR, { recursive: true })
mkdirSync(THUMBS_DIR, { recursive: true })
mkdirSync(AVATARS_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,
    username             TEXT UNIQUE NOT NULL,
    display_name         TEXT,
    password_hash        TEXT NOT NULL,
    is_admin             INTEGER NOT NULL DEFAULT 0,
    hourly_image_quota   INTEGER NOT NULL DEFAULT ${DEFAULT_HOURLY_IMAGE_QUOTA},
    max_batch_images     INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_BATCH_IMAGES},
    created_at           INTEGER NOT NULL,
    last_login_at        INTEGER,
    avatar_updated_at    INTEGER,
    public_storage_bytes INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code        TEXT PRIMARY KEY,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    max_uses    INTEGER NOT NULL DEFAULT 1,
    used_count  INTEGER NOT NULL DEFAULT 0,
    note        TEXT
  );

  CREATE TABLE IF NOT EXISTS invite_redemptions (
    code        TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    redeemed_at INTEGER NOT NULL,
    PRIMARY KEY (code, user_id)
  );

  CREATE TABLE IF NOT EXISTS user_stats (
    user_id            TEXT PRIMARY KEY,
    total_requests     INTEGER NOT NULL DEFAULT 0,
    success_count      INTEGER NOT NULL DEFAULT 0,
    failure_count      INTEGER NOT NULL DEFAULT 0,
    last_request_at    INTEGER,
    total_duration_ms  INTEGER NOT NULL DEFAULT 0,
    total_output_bytes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS request_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL,
    username          TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    provider          TEXT,
    api_mode          TEXT,
    model             TEXT,
    size              TEXT,
    quality           TEXT,
    n_images          INTEGER,
    has_input_image   INTEGER,
    input_image_count INTEGER,
    has_mask          INTEGER,
    prompt            TEXT,
    duration_ms       INTEGER,
    http_status       INTEGER,
    error_type        TEXT,
    error_message     TEXT,
    error_stack       TEXT,
    output_count      INTEGER,
    output_bytes      INTEGER,
    user_agent        TEXT,
    ip                TEXT,
    client_version    TEXT,
    created_at        INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_events_user_time ON request_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type_time ON request_events(event_type, created_at DESC);

  CREATE TABLE IF NOT EXISTS public_images (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    width      INTEGER,
    height     INTEGER,
    file_size  INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_public_created ON public_images(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_public_user ON public_images(user_id);

  CREATE TABLE IF NOT EXISTS team_config (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    updated_at    INTEGER NOT NULL,
    updated_by    TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    metadata   TEXT,
    read_at    INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);

  CREATE TABLE IF NOT EXISTS proxy_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    image_count INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_proxy_usage_user_time ON proxy_usage(user_id, created_at DESC);
`)

function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  }
}

ensureColumn('users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'display_name', 'display_name TEXT')
ensureColumn('users', 'hourly_image_quota', `hourly_image_quota INTEGER NOT NULL DEFAULT ${DEFAULT_HOURLY_IMAGE_QUOTA}`)
ensureColumn('users', 'max_batch_images', `max_batch_images INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_BATCH_IMAGES}`)
ensureColumn('users', 'last_login_at', 'last_login_at INTEGER')
ensureColumn('users', 'avatar_updated_at', 'avatar_updated_at INTEGER')
ensureColumn('users', 'public_storage_bytes', 'public_storage_bytes INTEGER NOT NULL DEFAULT 0')

// ===== seeding =====

interface UserRow {
  id: string
  username: string
  display_name: string | null
  password_hash: string
  is_admin: number
  hourly_image_quota: number
  max_batch_images: number
  created_at: number
  last_login_at: number | null
  avatar_updated_at: number | null
  public_storage_bytes: number
}

async function seedAdmins(envValue: string | undefined, isAdmin: boolean) {
  for (const pair of (envValue ?? '').split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const username = pair.slice(0, idx).trim()
    const password = pair.slice(idx + 1).trim()
    if (!username || !password) continue
    const existing = db.query('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | null
    if (existing) {
      if (isAdmin) db.query('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id)
      continue
    }
    const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })
    db.query('INSERT INTO users (id, username, password_hash, is_admin, hourly_image_quota, max_batch_images, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(),
      username,
      hash,
      isAdmin ? 1 : 0,
      getDefaultHourlyImageQuota(),
      DEFAULT_MAX_BATCH_IMAGES,
      Date.now(),
    )
    logger.info({ scope: 'auth', username, role: isAdmin ? 'admin' : 'user' }, 'Seeded user')
  }
}

await seedAdmins(process.env.ADMIN_USERS, true)
await seedAdmins(process.env.AUTH_USERS, false)

const adminCount = (db.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n
if (adminCount === 0) {
  logger.warn({ scope: 'auth', hint: 'set ADMIN_USERS=name:password' }, 'No admin users configured')
}

// 30 天事件清理
function purgeOldEvents() {
  const cutoff = Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const result = db.query('DELETE FROM request_events WHERE created_at < ?').run(cutoff)
  if (result.changes > 0) logger.info({ scope: 'telemetry', deleted: result.changes, retentionDays: EVENT_RETENTION_DAYS }, 'Purged old events')
}
purgeOldEvents()
setInterval(purgeOldEvents, 24 * 60 * 60 * 1000)

// 超过 1 小时的代理用量记录已不再影响配额，按天清理
function purgeOldProxyUsage() {
  const cutoff = Date.now() - 6 * HOUR_MS
  const result = db.query('DELETE FROM proxy_usage WHERE created_at < ?').run(cutoff)
  if (result.changes > 0) logger.info({ scope: 'quota', deleted: result.changes }, 'Purged old proxy_usage rows')
}
purgeOldProxyUsage()
setInterval(purgeOldProxyUsage, HOUR_MS)

// ===== 工具 =====

function normalizeQuotaValue(value: unknown, fallback = 100): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(100_000, Math.trunc(numeric)))
}

function normalizeBatchImageLimit(value: unknown, fallback = 10): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(100, Math.trunc(numeric)))
}

function parseQuotaPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100_000) return null
  return Math.trunc(numeric)
}

function parseBatchImageLimitPatchValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 100) return null
  return Math.trunc(numeric)
}

function readTeamSettingsRecord(): Record<string, unknown> {
  const row = db.query('SELECT settings_json FROM team_config WHERE id = 1').get() as { settings_json: string } | null
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.settings_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    logger.warn({ scope: 'admin' }, 'Invalid team_config.settings_json, using defaults')
  }
  return {}
}

function getTeamSettingsPayload() {
  const settings = readTeamSettingsRecord()
  return {
    defaultHourlyImageQuota: normalizeQuotaValue(settings.defaultHourlyImageQuota, DEFAULT_HOURLY_IMAGE_QUOTA),
  }
}

function getDefaultHourlyImageQuota(): number {
  return getTeamSettingsPayload().defaultHourlyImageQuota
}

function saveTeamSettingsRecord(settings: Record<string, unknown>, updatedBy: string | null) {
  db.query(`
    INSERT INTO team_config (id, settings_json, updated_at, updated_by)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      settings_json = excluded.settings_json,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(JSON.stringify(settings), Date.now(), updatedBy)
}

const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60_000
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return false
  }
  return ++entry.count > RATE_LIMIT
}

function getClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

function resolveStaticPath(urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }

  const relativePath = decoded.replace(/^\/+/, '') || 'index.html'
  const filePath = path.resolve(STATIC_DIR, relativePath)
  if (filePath !== STATIC_DIR && !filePath.startsWith(`${STATIC_DIR}${path.sep}`)) return null
  if (!existsSync(filePath)) return null
  try {
    if (!statSync(filePath).isFile()) return null
  } catch {
    return null
  }
  return filePath
}

function staticResponse(filePath: string, cacheControl: string): Response {
  const ext = path.extname(filePath).toLowerCase()
  return new Response(Bun.file(filePath), {
    headers: {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
    },
  })
}

function serveStaticAsset(c: Context): Response | null {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return null
  const filePath = resolveStaticPath(new URL(c.req.url).pathname)
  if (!filePath) return null
  const cacheControl = filePath.includes(`${path.sep}assets${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  return staticResponse(filePath, cacheControl)
}

function serveSpaFallback(): Response {
  const indexPath = resolveStaticPath('/index.html')
  if (!indexPath) return new Response('Static build not found. Run `bun run build` first.', { status: 404 })
  return staticResponse(indexPath, 'no-cache')
}

function makeToken(user: { id: string; username: string; is_admin: number }): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN_SECONDS
  return jwtSign({ sub: user.id, username: user.username, isAdmin: user.is_admin === 1, exp }, JWT_SECRET!)
}

async function requireAdmin(c: Context, next: Next) {
  const payload = c.get('jwtPayload') as { sub: string }
  const user = db.query('SELECT is_admin FROM users WHERE id = ?').get(payload.sub) as { is_admin: number } | null
  if (!user || user.is_admin !== 1) return c.json({ error: '需要管理员权限。请使用管理员账号登录后再操作。' }, 403)
  return next()
}

async function requireUser(c: Context, next: Next) {
  const payload = c.get('jwtPayload') as { sub: string }
  const user = db.query('SELECT id FROM users WHERE id = ?').get(payload.sub) as { id: string } | null
  if (!user) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)
  return next()
}

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 12; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

function getHourlySuccessfulImages(userId: string, now = Date.now()): { used: number; resetAt: number | null } {
  const cutoff = now - HOUR_MS
  const row = db.query(`
    SELECT COALESCE(SUM(image_count), 0) AS used, MIN(created_at) AS first_at
    FROM proxy_usage
    WHERE user_id = ? AND created_at >= ?
  `).get(userId, cutoff) as { used: number | null; first_at: number | null }

  const used = Math.max(0, Number(row.used ?? 0))
  return { used, resetAt: row.first_at ? row.first_at + HOUR_MS : null }
}

function recordProxyUsage(userId: string, imageCount: number, now = Date.now()): void {
  db.query('INSERT INTO proxy_usage (user_id, image_count, created_at) VALUES (?, ?, ?)').run(userId, Math.max(1, imageCount), now)
}

function getUserHourlyQuota(userId: string): number | null {
  const row = db.query('SELECT hourly_image_quota FROM users WHERE id = ?').get(userId) as { hourly_image_quota: number } | null
  return row ? normalizeQuotaValue(row.hourly_image_quota, DEFAULT_HOURLY_IMAGE_QUOTA) : null
}

function getUserMaxBatchImages(userId: string): number | null {
  const row = db.query('SELECT max_batch_images FROM users WHERE id = ?').get(userId) as { max_batch_images: number } | null
  return row ? normalizeBatchImageLimit(row.max_batch_images, DEFAULT_MAX_BATCH_IMAGES) : null
}

function normalizeDisplayNameValue(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string') return { error: '请输入要显示的名字。' }
  const displayName = value.replace(/\s+/g, ' ').trim()
  if (!displayName) return { error: '显示名不能为空。' }
  if (displayName.length > 24) return { error: '显示名最多 24 个字符。' }
  if (/[\u0000-\u001F\u007F]/.test(displayName)) return { error: '显示名不能包含控制字符。' }
  return { value: displayName }
}

function getAuthUserPayload(userId: string) {
  const user = db.query(`
    SELECT id, username, display_name, is_admin, hourly_image_quota, max_batch_images, avatar_updated_at, public_storage_bytes
    FROM users WHERE id = ?
  `).get(userId) as Pick<UserRow, 'id' | 'username' | 'display_name' | 'is_admin' | 'hourly_image_quota' | 'max_batch_images' | 'avatar_updated_at' | 'public_storage_bytes'> | null
  if (!user) return null

  const hourlyImageQuota = normalizeQuotaValue(user.hourly_image_quota, DEFAULT_HOURLY_IMAGE_QUOTA)
  const hourlyUsage = getHourlySuccessfulImages(user.id)
  const publicGalleryCount = (db.query('SELECT COUNT(*) AS n FROM public_images WHERE user_id = ?').get(user.id) as { n: number }).n
  const publicStorageBytes = Math.max(0, Number(user.public_storage_bytes ?? 0))

  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    isAdmin: user.is_admin === 1,
    avatarUpdatedAt: user.avatar_updated_at,
    hourlyImageQuota,
    maxBatchImages: normalizeBatchImageLimit(user.max_batch_images, DEFAULT_MAX_BATCH_IMAGES),
    hourlyUsed: hourlyUsage.used,
    hourlyRemaining: Math.max(0, hourlyImageQuota - hourlyUsage.used),
    quotaResetAt: hourlyUsage.resetAt,
    publicGalleryCount,
    publicStorageBytes,
    publicStorageQuotaBytes: PER_USER_PUBLIC_QUOTA_BYTES,
  }
}

function getPositiveIntegerValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(numeric)) return null
  return Math.max(1, Math.min(1000, Math.trunc(numeric)))
}

async function estimateRequestedImageCount(request: Request, targetPath: string): Promise<number> {
  if (!/\/images\/generations\/?$/i.test(targetPath)) return 1
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) return 1

  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) return 1

  const payload = await request.clone().json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 1
  const record = payload as Record<string, unknown>
  return getPositiveIntegerValue(record.n) ?? getPositiveIntegerValue(record.num_images) ?? 1
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function resolveApiProxyTarget(c: Context): URL | null {
  if (!API_PROXY_URL) return null

  const requestUrl = new URL(c.req.url)
  const prefix = '/api-proxy/'
  if (!requestUrl.pathname.startsWith(prefix)) return null

  const endpointPath = requestUrl.pathname.slice(prefix.length).replace(/^\/+/, '')
  if (!endpointPath) return null

  const target = new URL(API_PROXY_URL.endsWith('/') ? API_PROXY_URL : `${API_PROXY_URL}/`)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('API_PROXY_URL 只支持 http/https')
  }

  const basePath = target.pathname.replace(/\/+$/, '')
  target.pathname = `${basePath}/${endpointPath}`
  target.search = requestUrl.search
  return target
}

function createApiProxyRequestHeaders(c: Context): Headers {
  const headers = new Headers(c.req.raw.headers)
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
  headers.delete('host')
  headers.delete('x-picpilot-authorization')

  if (API_PROXY_API_KEY) {
    headers.set('authorization', `Bearer ${API_PROXY_API_KEY}`)
  } else if (!headers.get('authorization')?.replace(/^Bearer\s*$/i, '').trim()) {
    headers.delete('authorization')
  }

  return headers
}

function createApiProxyResponseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
  headers.set('Cache-Control', 'no-store')
  return headers
}

// ===== app =====

const app = new Hono()

app.use('*', async (c, next) => {
  const response = serveStaticAsset(c)
  if (response) return response
  return next()
})

// ===== Auth =====

app.post('/api/auth/login', async (c) => {
  if (isRateLimited(getClientIp(c))) {
    return c.json({ error: '登录失败次数过多，请稍后再试。' }, 429)
  }

  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password) return c.json({ error: '请输入用户名和密码。' }, 400)

  const user = db.query('SELECT * FROM users WHERE username = ?').get(username) as UserRow | null
  if (!user || !(await Bun.password.verify(password, user.password_hash))) {
    return c.json({ error: '用户名或密码错误，请重新输入。' }, 401)
  }

  db.query('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id)

  const token = await makeToken(user)
  const profile = getAuthUserPayload(user.id)
  if (!profile) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)
  return c.json({ token, ...profile })
})

app.post('/api/auth/register', async (c) => {
  if (isRateLimited(getClientIp(c))) {
    return c.json({ error: '请求过于频繁，请稍后再试。' }, 429)
  }

  const raw = await c.req.json().catch(() => ({}))
  const invite = typeof raw.invite === 'string' ? raw.invite.trim() : ''
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''
  const password = typeof raw.password === 'string' ? raw.password : ''
  if (!invite || !username || !password) return c.json({ error: '请输入邀请码、用户名和密码。' }, 400)
  if (username.length < 2 || username.length > 32) return c.json({ error: '用户名需要 2-32 个字符。' }, 400)
  if (/\s/.test(username)) return c.json({ error: '用户名不能包含空格或换行。' }, 400)
  if (password.length < 6) return c.json({ error: '密码至少需要 6 位。' }, 400)

  interface InviteRow {
    code: string
    expires_at: number | null
    max_uses: number
    used_count: number
  }
  const code = db.query('SELECT * FROM invite_codes WHERE code = ?').get(invite) as InviteRow | null
  if (!code) return c.json({ error: '邀请码无效，请检查是否输入完整。' }, 400)
  if (code.expires_at && code.expires_at < Date.now()) return c.json({ error: '邀请码已过期，请联系管理员重新获取。' }, 400)
  if (code.used_count >= code.max_uses) return c.json({ error: '邀请码已用完，请联系管理员重新获取。' }, 400)

  if (db.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
    return c.json({ error: '用户名已被占用，请换一个用户名。' }, 409)
  }

  const userId = crypto.randomUUID()
  const now = Date.now()
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })
  const defaultHourlyQuota = getDefaultHourlyImageQuota()

  let inviteExhausted = false
  try {
    db.transaction(() => {
      const claimed = db.query(
        'UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses AND (expires_at IS NULL OR expires_at >= ?)',
      ).run(invite, now)
      if (claimed.changes === 0) {
        inviteExhausted = true
        throw new Error('INVITE_EXHAUSTED')
      }
      db.query('INSERT INTO users (id, username, password_hash, is_admin, hourly_image_quota, max_batch_images, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)').run(
        userId, username, hash, defaultHourlyQuota, DEFAULT_MAX_BATCH_IMAGES, now, now,
      )
      db.query('INSERT INTO invite_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)').run(invite, userId, now)
    })()
  } catch (err) {
    if (inviteExhausted) {
      return c.json({ error: '邀请码已用完，请联系管理员重新获取。' }, 400)
    }
    throw err
  }

  const token = await makeToken({ id: userId, username, is_admin: 0 })
  const profile = getAuthUserPayload(userId)
  if (!profile) return c.json({ error: '注册失败，请稍后重试。' }, 500)
  return c.json({ token, ...profile })
})

app.use('/api/auth/me', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.get('/api/auth/me', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const profile = getAuthUserPayload(payload.sub)
  if (!profile) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)
  return c.json(profile)
})

app.use('/api/auth/profile', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.patch('/api/auth/profile', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => ({}))
  const normalized = normalizeDisplayNameValue((body as { displayName?: unknown }).displayName)
  if ('error' in normalized) return c.json({ error: normalized.error }, 400)

  const result = db.query('UPDATE users SET display_name = ? WHERE id = ?').run(normalized.value, payload.sub)
  if (result.changes === 0) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)

  const profile = getAuthUserPayload(payload.sub)
  if (!profile) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)
  return c.json(profile)
})

app.use('/api/auth/avatar', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.post('/api/auth/avatar', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => null) as { image_base64?: string } | null
  if (!body || typeof body.image_base64 !== 'string') {
    return c.json({ error: '请提供要上传的头像图片。' }, 400)
  }

  const base64 = body.image_base64.replace(/^data:image\/[a-z]+;base64,/, '')
  const inputBuffer = Buffer.from(base64, 'base64')
  if (inputBuffer.length === 0) return c.json({ error: '上传的图片为空，请重新选择。' }, 400)
  if (inputBuffer.length > MAX_AVATAR_INPUT_BYTES) return c.json({ error: '头像过大，请上传 5MB 以内的图片。' }, 413)

  let finalBuffer: Buffer
  try {
    finalBuffer = await sharp(inputBuffer)
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: 'cover', position: 'attention' })
      .webp({ quality: 85 })
      .toBuffer()
  } catch {
    return c.json({ error: '无法解析这张图片，请换一张试试。' }, 400)
  }

  await writeFile(path.join(AVATARS_DIR, `${payload.sub}.webp`), finalBuffer)
  const now = Date.now()
  db.query('UPDATE users SET avatar_updated_at = ? WHERE id = ?').run(now, payload.sub)
  return c.json({ avatarUpdatedAt: now })
})

app.delete('/api/auth/avatar', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  try { unlinkSync(path.join(AVATARS_DIR, `${payload.sub}.webp`)) } catch {}
  db.query('UPDATE users SET avatar_updated_at = NULL WHERE id = ?').run(payload.sub)
  return c.json({ ok: true })
})

app.use('/api/avatars/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.get('/api/avatars/:user_id', (c) => {
  const userId = c.req.param('user_id')
  const row = db.query('SELECT avatar_updated_at FROM users WHERE id = ?').get(userId) as { avatar_updated_at: number | null } | null
  if (!row || row.avatar_updated_at == null) return c.json({ error: '头像不存在。' }, 404)
  const file = path.join(AVATARS_DIR, `${userId}.webp`)
  if (!existsSync(file)) return c.json({ error: '头像文件丢失。' }, 404)
  return new Response(Bun.file(file), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(statSync(file).size),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
})

// ===== Authenticated API Proxy =====

app.use('/api-proxy/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256', headerName: 'X-PicPilot-Authorization' }))
app.use('/api-proxy/*', requireUser)
app.all('/api-proxy/*', async (c) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
          Allow: 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type, x-picpilot-authorization',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        },
      })
    }
  
  if (c.req.method !== 'POST' && c.req.method !== 'GET') {
    return new Response(JSON.stringify({ error: '团队 API 代理只接受 GET/POST 请求。' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'GET, POST, OPTIONS' },
    })
  }

  let target: URL | null
  try {
    target = resolveApiProxyTarget(c)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '团队 API 代理配置无效，请管理员检查部署环境变量。' }, 500)
  }
  if (!target) return c.json({ error: '团队 API 代理还没有配置上游地址，请管理员填写 TEAM_API_BASE_URL 或 API_PROXY_URL。' }, 503)

  const payload = c.get('jwtPayload') as { sub: string }
  const quota = getUserHourlyQuota(payload.sub)
  if (quota == null) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)
  const maxBatchImages = getUserMaxBatchImages(payload.sub)
  if (maxBatchImages == null) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)

  if (c.req.method === 'POST') {
    const requestedImages = await estimateRequestedImageCount(c.req.raw, target.pathname)
    if (requestedImages > maxBatchImages) {
      return c.json({
        error: `单次批量生成数量上限为 ${maxBatchImages} 张，本次请求 ${requestedImages} 张。请减少数量后重试。`,
        maxBatchImages,
        requested: requestedImages,
      }, 429)
    }
    const usage = getHourlySuccessfulImages(payload.sub)
    const remaining = Math.max(0, quota - usage.used)
    if (usage.used >= quota || requestedImages > remaining) {
      const resetAtText = usage.resetAt ? `，最早约 ${new Date(usage.resetAt).toLocaleString('zh-CN')} 释放部分额度` : ''
      const reason = usage.used >= quota
        ? '团队服务小时额度已用完'
        : `团队服务剩余额度不足（本次预计 ${requestedImages} 张，剩余 ${remaining} 张）`
      return c.json({
        error: `${reason}：过去 1 小时成功 ${usage.used}/${quota} 张${resetAtText}`,
        quota,
        used: usage.used,
        remaining,
        requested: requestedImages,
        resetAt: usage.resetAt,
      }, 429)
    }
    recordProxyUsage(payload.sub, requestedImages)
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: c.req.method,
      headers: createApiProxyRequestHeaders(c),
      body: c.req.method === 'POST' ? c.req.raw.body : undefined,
      signal: c.req.raw.signal,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '上游 API 请求失败，请稍后重试或联系管理员检查团队 API。' }, 502)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: createApiProxyResponseHeaders(upstream),
  })
})

// ===== Telemetry =====

app.use('/api/telemetry/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.post('/api/telemetry/event', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string; username: string }
  const e = await c.req.json().catch(() => null)
  if (!e || !e.event_type) return c.json({ error: '请求记录上报格式无效。' }, 400)

  const clip = (value: unknown, max: number): string | null => {
    if (value == null) return null
    const s = typeof value === 'string' ? value : String(value)
    return s.length > max ? s.slice(0, max) : s
  }

  const now = Date.now()
  const isSuccess = e.event_type === 'success'
  const isFailure = !isSuccess

  db.transaction(() => {
    db.query(`
      INSERT INTO request_events (
        user_id, username, event_type, provider, api_mode, model, size, quality, n_images,
        has_input_image, input_image_count, has_mask, prompt, duration_ms, http_status,
        error_type, error_message, error_stack, output_count, output_bytes,
        user_agent, ip, client_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.sub, payload.username, clip(e.event_type, 32),
      clip(e.provider, 64), clip(e.api_mode, 32), clip(e.model, 128), clip(e.size, 32), clip(e.quality, 32), e.n_images ?? null,
      e.has_input_image ? 1 : 0, e.input_image_count ?? null, e.has_mask ? 1 : 0,
      clip(e.prompt, 4000), e.duration_ms ?? null, e.http_status ?? null,
      clip(e.error_type, 64), clip(e.error_message, 2000), clip(e.error_stack, 8000),
      e.output_count ?? null, e.output_bytes ?? null,
      clip(c.req.header('user-agent'), 512), getClientIp(c), clip(e.client_version, 64), now,
    )

    db.query(`
      INSERT INTO user_stats (
        user_id, total_requests, success_count, failure_count,
        last_request_at, total_duration_ms, total_output_bytes
      ) VALUES (?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        total_requests     = total_requests + 1,
        success_count      = success_count + excluded.success_count,
        failure_count      = failure_count + excluded.failure_count,
        last_request_at    = excluded.last_request_at,
        total_duration_ms  = total_duration_ms + excluded.total_duration_ms,
        total_output_bytes = total_output_bytes + excluded.total_output_bytes
    `).run(
      payload.sub,
      isSuccess ? 1 : 0,
      isFailure ? 1 : 0,
      now,
      e.duration_ms ?? 0,
      e.output_bytes ?? 0,
    )
  })()

  return c.json({ ok: true })
})

// ===== Admin =====

app.use('/api/admin/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.use('/api/admin/*', requireAdmin)

app.get('/api/admin/team-settings', (c) => {
  return c.json(getTeamSettingsPayload())
})

app.patch('/api/admin/team-settings', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => ({})) as unknown
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const settings = readTeamSettingsRecord()
  let hasUpdates = false

  if ('defaultHourlyImageQuota' in record) {
    const quota = parseQuotaPatchValue(record.defaultHourlyImageQuota)
    if (quota == null) return c.json({ error: '默认小时额度必须是 0 到 100000 之间的数字。0 表示新用户默认暂停团队服务。' }, 400)
    settings.defaultHourlyImageQuota = quota
    hasUpdates = true
  }

  if (!hasUpdates) return c.json({ error: '没有可更新的字段。' }, 400)
  saveTeamSettingsRecord(settings, payload.sub)
  return c.json(getTeamSettingsPayload())
})

app.get('/api/admin/users', (c) => {
  const hourAgo = Date.now() - HOUR_MS
  const rows = db.query(`
    SELECT u.id, u.username, u.is_admin, u.hourly_image_quota, u.max_batch_images, u.created_at, u.last_login_at,
           u.avatar_updated_at,
           s.total_requests, s.success_count, s.failure_count,
           s.last_request_at,
           s.total_duration_ms, s.total_output_bytes,
           COALESCE(h.hourly_success_images, 0) AS hourly_success_images
    FROM users u
    LEFT JOIN user_stats s ON s.user_id = u.id
    LEFT JOIN (
      SELECT user_id,
             COALESCE(SUM(image_count), 0) AS hourly_success_images
      FROM proxy_usage
      WHERE created_at >= ?
      GROUP BY user_id
    ) h ON h.user_id = u.id
    ORDER BY u.created_at DESC
  `).all(hourAgo)
  return c.json({ users: rows })
})

app.patch('/api/admin/users/:id', async (c) => {
  const id = c.req.param('id')
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => ({}))
  if (body.isAdmin === false) {
    if (id === payload.sub) {
      return c.json({ error: '不能取消自己的管理员身份，请改用其他管理员账号操作。' }, 400)
    }
    const target = db.query('SELECT is_admin FROM users WHERE id = ?').get(id) as { is_admin: number } | null
    if (target?.is_admin === 1) {
      const adminCount = (db.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n
      if (adminCount <= 1) {
        return c.json({ error: '至少需要保留一个管理员，无法降级最后一个管理员。' }, 400)
      }
    }
  }
  const updates: string[] = []
  const args: unknown[] = []
  if (typeof body.isAdmin === 'boolean') { updates.push('is_admin = ?'); args.push(body.isAdmin ? 1 : 0) }
  if ('hourlyImageQuota' in body) {
    const quota = parseQuotaPatchValue(body.hourlyImageQuota)
    if (quota == null) return c.json({ error: '小时额度必须是 0 到 100000 之间的数字。0 表示暂停该用户使用团队服务。' }, 400)
    updates.push('hourly_image_quota = ?')
    args.push(quota)
  }
  if ('maxBatchImages' in body) {
    const maxBatchImages = parseBatchImageLimitPatchValue(body.maxBatchImages)
    if (maxBatchImages == null) return c.json({ error: '批量生成数量上限必须是 1 到 100 之间的数字。' }, 400)
    updates.push('max_batch_images = ?')
    args.push(maxBatchImages)
  }
  if (typeof body.password === 'string' && body.password.length >= 6) {
    updates.push('password_hash = ?')
    args.push(await Bun.password.hash(body.password, { algorithm: 'bcrypt', cost: 10 }))
  }
  if (updates.length === 0) return c.json({ error: '没有可更新的字段。' }, 400)
  args.push(id)
  const result = db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...(args as never[]))
  if (result.changes === 0) return c.json({ error: '用户不存在，可能已被删除。' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/admin/users/:id', (c) => {
  const id = c.req.param('id')
  const payload = c.get('jwtPayload') as { sub: string }
  if (id === payload.sub) return c.json({ error: '不能删除当前登录的管理员账号。' }, 400)

  const imgs = db.query('SELECT id FROM public_images WHERE user_id = ?').all(id) as Array<{ id: string }>
  for (const img of imgs) {
    try { unlinkSync(path.join(PUBLIC_DIR, `${img.id}.webp`)) } catch {}
    try { unlinkSync(path.join(THUMBS_DIR, `${img.id}.webp`)) } catch {}
  }

  const result = db.query('DELETE FROM users WHERE id = ?').run(id)
  if (result.changes === 0) return c.json({ error: '用户不存在，可能已被删除。' }, 404)
  return c.json({ ok: true })
})

app.get('/api/admin/invites', (c) => {
  const invites = db.query(`
    SELECT c.code, c.created_by, c.created_at, c.expires_at, c.max_uses, c.used_count, c.note,
           u.username AS creator_username
    FROM invite_codes c
    LEFT JOIN users u ON u.id = c.created_by
    ORDER BY c.created_at DESC
  `).all() as Array<{ code: string }>

  const redemptions = db.query(`
    SELECT r.code, r.user_id, r.redeemed_at, u.username
    FROM invite_redemptions r
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.redeemed_at DESC
  `).all() as Array<{ code: string; user_id: string; redeemed_at: number; username: string | null }>

  const byCode = new Map<string, Array<{ user_id: string; username: string | null; redeemed_at: number }>>()
  for (const r of redemptions) {
    const list = byCode.get(r.code) ?? []
    list.push({ user_id: r.user_id, username: r.username, redeemed_at: r.redeemed_at })
    byCode.set(r.code, list)
  }

  const enriched = invites.map((inv) => ({ ...inv, redemptions: byCode.get(inv.code) ?? [] }))
  return c.json({ invites: enriched })
})

app.post('/api/admin/invites', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => ({}))
  const maxUses = Math.max(1, Math.min(1000, Number(body.maxUses ?? 1)))
  const count = Math.max(1, Math.min(50, Number(body.count ?? 1)))
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null
  const expiresAt = body.expiresAt ? Number(body.expiresAt) : null

  const insert = db.query(`
    INSERT INTO invite_codes (code, created_by, created_at, expires_at, max_uses, used_count, note)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `)
  const now = Date.now()
  const codes: string[] = []
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const code = generateInviteCode()
      insert.run(code, payload.sub, now, expiresAt, maxUses, note)
      codes.push(code)
    }
  })()

  return c.json({ code: codes[0], codes })
})

app.delete('/api/admin/invites/:code', (c) => {
  const code = c.req.param('code')
  const result = db.query('DELETE FROM invite_codes WHERE code = ?').run(code)
  if (result.changes === 0) return c.json({ error: '邀请码不存在，可能已被吊销。' }, 404)
  return c.json({ ok: true })
})

app.get('/api/admin/events', (c) => {
  const userId = c.req.query('user_id')
  const eventType = c.req.query('event_type')
  const errorType = c.req.query('error_type')
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const since = c.req.query('since') ? Number(c.req.query('since')) : null
  const until = c.req.query('until') ? Number(c.req.query('until')) : null

  const where: string[] = []
  const args: unknown[] = []
  if (userId) { where.push('user_id = ?'); args.push(userId) }
  if (eventType) { where.push('event_type = ?'); args.push(eventType) }
  if (errorType) { where.push('error_type = ?'); args.push(errorType) }
  if (since) { where.push('created_at >= ?'); args.push(since) }
  if (until) { where.push('created_at <= ?'); args.push(until) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const events = db.query(`
    SELECT * FROM request_events ${whereSql}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...(args as never[]), limit, offset)
  const total = (db.query(`SELECT COUNT(*) AS n FROM request_events ${whereSql}`).get(...(args as never[])) as { n: number }).n

  return c.json({ events, total })
})

const EVENT_EXPORT_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'created_at', label: '时间' },
  { key: 'id', label: 'ID' },
  { key: 'username', label: '用户名' },
  { key: 'user_id', label: '用户ID' },
  { key: 'event_type', label: '结果' },
  { key: 'provider', label: '服务商' },
  { key: 'api_mode', label: '接口模式' },
  { key: 'model', label: '模型' },
  { key: 'size', label: '尺寸' },
  { key: 'quality', label: '质量' },
  { key: 'n_images', label: '请求张数' },
  { key: 'has_input_image', label: '参考图数' },
  { key: 'has_mask', label: '遮罩' },
  { key: 'prompt', label: '提示词' },
  { key: 'duration_ms', label: '耗时ms' },
  { key: 'http_status', label: 'HTTP状态' },
  { key: 'error_type', label: '错误类型' },
  { key: 'error_message', label: '错误信息' },
  { key: 'output_count', label: '输出张数' },
  { key: 'output_bytes', label: '输出字节' },
  { key: 'user_agent', label: '浏览器' },
  { key: 'ip', label: 'IP' },
  { key: 'client_version', label: '客户端版本' },
]

function csvEscape(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

app.get('/api/admin/events/export', (c) => {
  const userId = c.req.query('user_id')
  const eventType = c.req.query('event_type')
  const errorType = c.req.query('error_type')
  const sinceRaw = c.req.query('since')
  const untilRaw = c.req.query('until')
  if (!sinceRaw || !untilRaw) {
    return c.json({ error: '请指定导出的起止日期' }, 400)
  }
  const since = Number(sinceRaw)
  const until = Number(untilRaw)
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) {
    return c.json({ error: '起止日期无效' }, 400)
  }
  const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000
  if (until - since > MAX_RANGE_MS) {
    return c.json({ error: '导出范围不能超过 31 天' }, 400)
  }

  const where: string[] = ['created_at >= ?', 'created_at <= ?']
  const args: unknown[] = [since, until]
  if (userId) { where.push('user_id = ?'); args.push(userId) }
  if (eventType) { where.push('event_type = ?'); args.push(eventType) }
  if (errorType) { where.push('error_type = ?'); args.push(errorType) }
  const whereSql = `WHERE ${where.join(' AND ')}`

  const rows = db.query(`
    SELECT * FROM request_events ${whereSql} ORDER BY created_at ASC
  `).all(...(args as never[])) as Array<Record<string, unknown>>

  const headerLine = EVENT_EXPORT_COLUMNS.map((c) => csvEscape(c.label)).join(',')
  const dataLines = rows.map((row) =>
    EVENT_EXPORT_COLUMNS.map(({ key }) => {
      const v = row[key]
      if (key === 'created_at' && typeof v === 'number') return csvEscape(new Date(v).toISOString())
      if (key === 'has_mask') return csvEscape(v ? '是' : '否')
      return csvEscape(v)
    }).join(','),
  )
  const csv = '﻿' + [headerLine, ...dataLines].join('\r\n')

  const startDate = new Date(since).toISOString().slice(0, 10)
  const endDate = new Date(until).toISOString().slice(0, 10)
  const filename = `picpilot-events-${startDate}_${endDate}.csv`

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
})

app.get('/api/admin/overview', (c) => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const totals = db.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN event_type = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN event_type != 'success' THEN 1 ELSE 0 END) AS failure,
      AVG(duration_ms) AS avg_duration,
      SUM(output_bytes) AS total_output
    FROM request_events WHERE created_at >= ?
  `).get(sevenDaysAgo)

  const errors = db.query(`
    SELECT error_type, COUNT(*) AS n FROM request_events
    WHERE created_at >= ? AND error_type IS NOT NULL
    GROUP BY error_type ORDER BY n DESC
  `).all(sevenDaysAgo)

  const providers = db.query(`
    SELECT provider, COUNT(*) AS n FROM request_events
    WHERE created_at >= ? AND provider IS NOT NULL
    GROUP BY provider ORDER BY n DESC
  `).all(sevenDaysAgo)

  return c.json({ totals, errors, providers })
})

app.post('/api/admin/gallery/:id/revoke', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string; username: string }
  const id = c.req.param('id')
  const img = db.query(`
    SELECT p.id, p.user_id, p.prompt, p.file_size,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS owner_name
    FROM public_images p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).get(id) as { id: string; user_id: string; prompt: string; file_size: number | null; owner_name: string } | null
  if (!img) return c.json({ error: '图片不存在，可能已被删除。' }, 404)

  const body = await c.req.json().catch(() => ({})) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const actor = db.query('SELECT username, display_name FROM users WHERE id = ?').get(payload.sub) as { username: string; display_name: string | null } | null
  const actorName = actor?.display_name?.trim() || actor?.username || payload.username || '管理员'

  try { unlinkSync(path.join(PUBLIC_DIR, `${id}.webp`)) } catch {}
  try { unlinkSync(path.join(THUMBS_DIR, `${id}.webp`)) } catch {}

  const promptExcerpt = img.prompt.length > 80 ? `${img.prompt.slice(0, 80)}…` : img.prompt
  const notificationBody = reason
    ? `你的公开图「${promptExcerpt}」已被管理员撤下。\n理由：${reason}`
    : `你的公开图「${promptExcerpt}」已被管理员撤下。`
  const metadata = JSON.stringify({
    image_id: img.id,
    prompt_excerpt: promptExcerpt,
    reason: reason || null,
    actor_username: actor?.username ?? null,
    actor_display_name: actorName,
  })

  // 不给自己撤自己留通知（管理员手滑场景）
  const shouldNotify = img.user_id !== payload.sub

  db.transaction(() => {
    db.query('DELETE FROM public_images WHERE id = ?').run(id)
    if (img.file_size) {
      db.query('UPDATE users SET public_storage_bytes = MAX(0, public_storage_bytes - ?) WHERE id = ?').run(img.file_size, img.user_id)
    }
    if (shouldNotify) {
      db.query(`
        INSERT INTO notifications (user_id, type, title, body, metadata, created_at)
        VALUES (?, 'gallery_revoked', ?, ?, ?, ?)
      `).run(img.user_id, '公开图已被撤下', notificationBody, metadata, Date.now())
    }
  })()

  logger.info({ scope: 'admin', actor: actor?.username, owner: img.user_id, imageId: id, hasReason: Boolean(reason) }, 'Gallery image revoked')
  return c.json({ ok: true })
})

// ===== Notifications =====

app.use('/api/notifications/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))

interface NotificationRow {
  id: number
  type: string
  title: string
  body: string
  metadata: string | null
  read_at: number | null
  created_at: number
}

function serializeNotification(row: NotificationRow) {
  let metadata: unknown = null
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata) } catch { metadata = null }
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    metadata,
    read_at: row.read_at,
    created_at: row.created_at,
  }
}

app.get('/api/notifications', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const rows = db.query(`
    SELECT id, type, title, body, metadata, read_at, created_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(payload.sub, limit, offset) as NotificationRow[]
  const total = (db.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(payload.sub) as { n: number }).n
  const unread = (db.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(payload.sub) as { n: number }).n
  return c.json({ items: rows.map(serializeNotification), total, unread })
})

app.get('/api/notifications/unread-count', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const unread = (db.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(payload.sub) as { n: number }).n
  return c.json({ unread })
})

app.post('/api/notifications/read', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => ({})) as { ids?: unknown }
  const now = Date.now()
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((v) => Number.isFinite(Number(v))).map((v) => Number(v))
    if (ids.length === 0) return c.json({ ok: true, updated: 0 })
    const placeholders = ids.map(() => '?').join(',')
    const result = db.query(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
    ).run(now, payload.sub, ...ids)
    return c.json({ ok: true, updated: result.changes })
  }
  const result = db.query('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, payload.sub)
  return c.json({ ok: true, updated: result.changes })
})

// ===== Gallery =====

app.use('/api/gallery/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))

app.post('/api/gallery', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string; username: string }

  const used = (db.query('SELECT public_storage_bytes AS bytes FROM users WHERE id = ?').get(payload.sub) as { bytes: number } | null)?.bytes ?? 0
  if (used >= PER_USER_PUBLIC_QUOTA_BYTES) {
    return c.json({ error: '公开画廊空间已用完，请先删除一些公开图片后再上传。' }, 413)
  }

  const body = await c.req.json().catch(() => null) as { image_base64?: string; prompt?: string } | null
  if (!body || typeof body.image_base64 !== 'string' || typeof body.prompt !== 'string') {
    return c.json({ error: '请提供要公开的图片和提示词。' }, 400)
  }

  const base64 = body.image_base64.replace(/^data:image\/[a-z]+;base64,/, '')
  const inputBuffer = Buffer.from(base64, 'base64')
  if (inputBuffer.length > 50 * 1024 * 1024) return c.json({ error: '图片过大，请上传 50MB 以内的图片。' }, 413)

  const id = crypto.randomUUID()
  const finalBuffer = await sharp(inputBuffer)
    .resize({ width: MAX_IMAGE_LONG_EDGE, height: MAX_IMAGE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer()
  const finalMeta = await sharp(finalBuffer).metadata()
  const thumbBuffer = await sharp(inputBuffer)
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: 'inside' })
    .webp({ quality: 80 })
    .toBuffer()

  await Promise.all([
    writeFile(path.join(PUBLIC_DIR, `${id}.webp`), finalBuffer),
    writeFile(path.join(THUMBS_DIR, `${id}.webp`), thumbBuffer),
  ])

  db.transaction(() => {
    db.query(`
      INSERT INTO public_images (id, user_id, prompt, width, height, file_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, payload.sub, body.prompt!.slice(0, 4000), finalMeta.width ?? null, finalMeta.height ?? null, finalBuffer.length, Date.now())
    db.query('UPDATE users SET public_storage_bytes = public_storage_bytes + ? WHERE id = ?').run(finalBuffer.length, payload.sub)
  })()

  return c.json({ id, width: finalMeta.width, height: finalMeta.height, size: finalBuffer.length })
})

app.get('/api/gallery', (c) => {
  const limit = Math.min(60, Math.max(1, Number(c.req.query('limit') ?? 24)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const userId = c.req.query('user_id')

  const where = userId ? 'WHERE p.user_id = ?' : ''
  const args = userId ? [userId] : []
  const images = db.query(`
    SELECT p.id, p.user_id,
           u.username,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name,
           u.avatar_updated_at,
           p.prompt, p.width, p.height, p.file_size, p.created_at
    FROM public_images p
    JOIN users u ON u.id = p.user_id
    ${where}
    ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `).all(...(args as never[]), limit, offset)
  const total = (db.query(`SELECT COUNT(*) AS n FROM public_images p ${where}`).get(...(args as never[])) as { n: number }).n
  return c.json({ images, total })
})

app.delete('/api/gallery/:id', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const id = c.req.param('id')
  const img = db.query('SELECT user_id, file_size FROM public_images WHERE id = ?').get(id) as { user_id: string; file_size: number | null } | null
  if (!img) return c.json({ error: '图片不存在，可能已被删除。' }, 404)

  if (img.user_id !== payload.sub) return c.json({ error: '无权删除这张图片。' }, 403)

  try { unlinkSync(path.join(PUBLIC_DIR, `${id}.webp`)) } catch {}
  try { unlinkSync(path.join(THUMBS_DIR, `${id}.webp`)) } catch {}
  db.transaction(() => {
    db.query('DELETE FROM public_images WHERE id = ?').run(id)
    if (img.file_size) {
      db.query('UPDATE users SET public_storage_bytes = MAX(0, public_storage_bytes - ?) WHERE id = ?').run(img.file_size, img.user_id)
    }
  })()
  return c.json({ ok: true })
})

// 鉴权后流式返回公开图（原图或缩略图）
app.get('/api/gallery/image/:id', (c) => {
  const id = c.req.param('id')
  const isThumb = c.req.query('thumb') === '1'
  const exists = db.query('SELECT 1 FROM public_images WHERE id = ?').get(id)
  if (!exists) return c.json({ error: '图片不存在，可能已被删除。' }, 404)

  const file = path.join(isThumb ? THUMBS_DIR : PUBLIC_DIR, `${id}.webp`)
  if (!existsSync(file)) return c.json({ error: '图片文件丢失，请联系管理员检查服务器存储。' }, 404)

  // Bun.file 直接当 Response body，零拷贝
  return new Response(Bun.file(file), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(statSync(file).size),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
})

app.notFound((c) => {
  const pathname = new URL(c.req.url).pathname
  if (pathname.startsWith('/api/')) return c.json({ error: '接口不存在。' }, 404)
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Not Found', 404)
  return serveSpaFallback()
})

// ===== boot =====

const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
})

logger.info({ scope: 'server', url: server.url.href.replace(/\/$/, '') }, 'picpilot ready')
logger.info({
  scope: 'server',
  port: PORT,
  staticDir: STATIC_DIR,
  dataDir: DATA_DIR,
  dbPath: DB_PATH,
  apiProxy: Boolean(API_PROXY_URL),
  defaultQuota: getDefaultHourlyImageQuota(),
  defaultMaxBatchImages: DEFAULT_MAX_BATCH_IMAGES,
}, 'Runtime configuration')
