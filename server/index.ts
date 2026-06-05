import { Hono, type Context, type Next } from 'hono'
import { jwt as jwtMiddleware, sign as jwtSign } from 'hono/jwt'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import sharp from 'sharp'
import path from 'path'
import { existsSync, statSync } from 'fs'
import { unlink, writeFile } from 'fs/promises'
import { createConcurrencyQueue, QueueFullError, ClientAbortError } from './concurrencyQueue.ts'
import { generateInviteCode, getPositiveIntegerValue, normalizeBatchImageLimit, parseBatchImageLimitPatchValue, normalizeConcurrencyLimit, parseConcurrencyPatchValue, normalizeQueueLimit, parseQueuePatchValue } from './utils/validation.ts'

import {
  AVATAR_SIZE,
  AVATARS_DIR,
  API_PROXY_API_KEY,
  API_PROXY_URL,
  DATA_DIR,
  DB_PATH,
  DEFAULT_MAX_BATCH_IMAGES,
  EVENT_RETENTION_DAYS,
  INVITE_MAX_BATCH_COUNT,
  INVITE_MAX_USES,
  INVITE_NOTE_MAX_LEN,
  JWT_EXPIRES_IN_SECONDS,
  JWT_SESSION_MAX_SECONDS,
  JWT_SECRET,
  logger,
  MAX_AVATAR_INPUT_BYTES,
  MAX_CONCURRENT,
  MAX_IMAGE_LONG_EDGE,
  MIME_TYPES,
  PER_USER_PUBLIC_QUOTA_BYTES,
  PORT,
  PROXY_QUEUE_MAX,
  PROXY_QUEUE_MAX_WAIT_MS,
  PUBLIC_DIR,
  STATIC_DIR,
  THUMB_LONG_EDGE,
  THUMBS_DIR,
} from './config.ts'

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
    max_batch_images     INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_BATCH_IMAGES},
    created_at           INTEGER NOT NULL,
    last_login_at        INTEGER,
    avatar_updated_at    INTEGER,
    public_storage_bytes INTEGER NOT NULL DEFAULT 0,
    disabled             INTEGER NOT NULL DEFAULT 0,
    token_version        INTEGER NOT NULL DEFAULT 0
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

  -- 公开图对应的「原图」（生成该图时 @ 引用的输入图），随主图一起公开
  CREATE TABLE IF NOT EXISTS public_image_originals (
    id         TEXT PRIMARY KEY,
    image_id   TEXT NOT NULL,
    position   INTEGER NOT NULL,
    width      INTEGER,
    height     INTEGER,
    file_size  INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (image_id) REFERENCES public_images(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_public_originals_image ON public_image_originals(image_id);

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
  CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by);
`)

function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  }
}

ensureColumn('users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'display_name', 'display_name TEXT')
ensureColumn('users', 'max_batch_images', `max_batch_images INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_BATCH_IMAGES}`)
ensureColumn('users', 'last_login_at', 'last_login_at INTEGER')
ensureColumn('users', 'avatar_updated_at', 'avatar_updated_at INTEGER')
ensureColumn('users', 'public_storage_bytes', 'public_storage_bytes INTEGER NOT NULL DEFAULT 0')
// 禁用账号：禁用后无法登录/出图，已登录会话也会被拒，可随时启用
ensureColumn('users', 'disabled', 'disabled INTEGER NOT NULL DEFAULT 0')
// 令牌版本：JWT 携带 tv 声明，自增即令该用户所有旧令牌失效（改密码 = 全设备登出）
ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0')
// 共享画廊「推荐」：管理员可标记，被标记的图缩略图右上角显示点赞图案并在画廊置顶
ensureColumn('public_images', 'featured', 'featured INTEGER NOT NULL DEFAULT 0')

// ===== seeding =====

interface UserRow {
  id: string
  username: string
  display_name: string | null
  password_hash: string
  is_admin: number
  max_batch_images: number
  created_at: number
  last_login_at: number | null
  avatar_updated_at: number | null
  public_storage_bytes: number
  disabled: number
  token_version: number
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
    db.query('INSERT INTO users (id, username, password_hash, is_admin, max_batch_images, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(),
      username,
      hash,
      isAdmin ? 1 : 0,
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
// 后台定时任务只在作为主进程运行时启动；测试经 app.request 驱动时不挂这些计时器，避免事件循环常驻。
if (import.meta.main) {
  setInterval(purgeOldEvents, 24 * 60 * 60 * 1000)

  // 定期清理过期的登录限速记录，防止内存泄漏
  setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of loginAttempts) {
      if (entry.resetAt < now) loginAttempts.delete(ip)
    }
  }, 5 * 60 * 1000)
}

// ===== 工具 =====

let cachedTeamSettings: Record<string, unknown> | null = null

// 返回缓存的浅拷贝，避免调用方原地改写污染缓存（缓存与数据库在写库失败时会分叉）
function readTeamSettingsRecord(): Record<string, unknown> {
  if (cachedTeamSettings) return { ...cachedTeamSettings }
  const row = db.query('SELECT settings_json FROM team_config WHERE id = 1').get() as { settings_json: string } | null
  if (!row) { cachedTeamSettings = {}; return {} }
  try {
    const parsed = JSON.parse(row.settings_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cachedTeamSettings = parsed as Record<string, unknown>
      return { ...cachedTeamSettings }
    }
  } catch {
    logger.warn({ scope: 'admin' }, 'Invalid team_config.settings_json, using defaults')
  }
  cachedTeamSettings = {}
  return {}
}

function getTeamSettingsPayload() {
  const settings = readTeamSettingsRecord()
  return {
    defaultMaxBatchImages: normalizeBatchImageLimit(settings.defaultMaxBatchImages, DEFAULT_MAX_BATCH_IMAGES),
    // 并发/排队上限优先采用管理端配置，未配置时回退到环境默认值（MAX_CONCURRENT / PROXY_QUEUE_MAX）。
    maxConcurrent: normalizeConcurrencyLimit(settings.maxConcurrent, MAX_CONCURRENT),
    maxQueue: normalizeQueueLimit(settings.maxQueue, PROXY_QUEUE_MAX),
  }
}

// 新注册用户的默认批量上限：优先采用管理端配置的团队设置，未配置时回退到环境默认值
function getDefaultMaxBatchImages(): number {
  return getTeamSettingsPayload().defaultMaxBatchImages
}

// 公开到画廊时，一张主图最多附带多少张「原图」
const MAX_PUBLIC_ORIGINALS = 9

interface ProcessedPublicImage {
  id: string
  finalBuffer: Buffer
  thumbBuffer: Buffer
  width?: number
  height?: number
}

class PublicImageTooLargeError extends Error {}

// 将 base64/dataURL 图片处理成画廊存储格式（webp 主图 + 缩略图），并附带尺寸信息。
// 处理不了（解码失败等）会抛错；过大抛 PublicImageTooLargeError。
async function processPublicImage(imageBase64: string): Promise<ProcessedPublicImage> {
  const base64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')
  const inputBuffer = Buffer.from(base64, 'base64')
  if (inputBuffer.length > 50 * 1024 * 1024) throw new PublicImageTooLargeError()

  const finalBuffer = await sharp(inputBuffer)
    .resize({ width: MAX_IMAGE_LONG_EDGE, height: MAX_IMAGE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer()
  const meta = await sharp(finalBuffer).metadata()
  const thumbBuffer = await sharp(inputBuffer)
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: 'inside' })
    .webp({ quality: 80 })
    .toBuffer()

  return { id: crypto.randomUUID(), finalBuffer, thumbBuffer, width: meta.width, height: meta.height }
}

// 删除一张公开图（含其原图）对应的图片与缩略图文件，忽略文件不存在等错误。
// 需在删除 public_images 行之前调用，否则 originals 行已被级联删除、无法取回 id。
// 按已知文件 id 删除主图 + 缩略图（不查 DB）。用于发布事务回滚后清理已落盘的孤儿文件。
function cleanupPublicImageFiles(mainId: string, originalIds: string[]): Promise<unknown> {
  const ids = [mainId, ...originalIds]
  return Promise.allSettled(
    ids.flatMap((fileId) => [
      unlink(path.join(PUBLIC_DIR, `${fileId}.webp`)).catch(() => {}),
      unlink(path.join(THUMBS_DIR, `${fileId}.webp`)).catch(() => {}),
    ]),
  )
}

// 删除某张公开图及其原图的全部文件：先查 DB 拿原图 id，故必须在 DELETE 级联前调用。
function deletePublicImageFiles(id: string): Promise<unknown> {
  const originals = db.query('SELECT id FROM public_image_originals WHERE image_id = ?').all(id) as Array<{ id: string }>
  return cleanupPublicImageFiles(id, originals.map((o) => o.id))
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
  cachedTeamSettings = { ...settings }
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
  return c.req.header('x-real-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? 'unknown'
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

// 短时访问令牌：携带 tv（令牌版本，用于撤销）与 sst（会话起始秒，用于绝对上限）。
// 刷新时传入原 sst 以保留同一会话的绝对寿命；登录/注册不传，从当前时刻起算新会话。
function makeToken(user: { id: string; username: string; is_admin: number; token_version: number }, sessionStart?: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const sst = sessionStart ?? now
  const exp = now + JWT_EXPIRES_IN_SECONDS
  return jwtSign({ sub: user.id, username: user.username, isAdmin: user.is_admin === 1, tv: user.token_version, sst, exp }, JWT_SECRET!)
}

// 禁用账号统一文案：登录、代理、/api/auth/me 共用，保证提示一致
const ACCOUNT_DISABLED_MESSAGE = '账号已被禁用，请联系管理员。'

interface SessionRow {
  id: string
  username: string
  is_admin: number
  disabled: number
  token_version: number
}

// 校验 JWT 声明与数据库当前状态是否一致：用户仍存在、未禁用、令牌版本未被撤销。
// 返回 401/403 响应表示拒绝，返回 null 表示通过。集中实现，供 requireUser/requireAdmin/me/refresh 复用。
// tv 声明缺失（本次安全升级前签发的旧长效令牌、或测试令牌缺省）按已撤销处理 → 强制重新登录换取短令牌。
function validateSession(c: Context): { row: SessionRow } | { reject: Response } {
  const payload = c.get('jwtPayload') as { sub?: string; tv?: number }
  const row = db.query('SELECT id, username, is_admin, disabled, token_version FROM users WHERE id = ?').get(payload?.sub ?? '') as SessionRow | null
  if (!row) return { reject: c.json({ error: '登录状态已失效，请重新登录。' }, 401) }
  if (row.disabled === 1) return { reject: c.json({ error: ACCOUNT_DISABLED_MESSAGE }, 403) }
  if (payload.tv !== row.token_version) return { reject: c.json({ error: '登录状态已失效，请重新登录。' }, 401) }
  return { row }
}

async function requireAdmin(c: Context, next: Next) {
  const result = validateSession(c)
  if ('reject' in result) return result.reject
  if (result.row.is_admin !== 1) return c.json({ error: '需要管理员权限。请使用管理员账号登录后再操作。' }, 403)
  return next()
}

async function requireUser(c: Context, next: Next) {
  const result = validateSession(c)
  if ('reject' in result) return result.reject
  return next()
}

// 批量上限统一为团队默认（option B）：不再按 per-user 列区分。
// 仍校验用户是否存在（保留对已删除用户的 401；/api-proxy/* 另有 requireUser 兜底）。
function getUserMaxBatchImages(userId: string): number | null {
  const row = db.query('SELECT 1 FROM users WHERE id = ?').get(userId)
  return row ? getDefaultMaxBatchImages() : null
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
    SELECT u.id, u.username, u.display_name, u.is_admin, u.disabled,
           u.avatar_updated_at, u.public_storage_bytes,
           (SELECT COUNT(*) FROM public_images pi WHERE pi.user_id = u.id) AS public_gallery_count
    FROM users u WHERE u.id = ?
  `).get(userId) as (Pick<UserRow, 'id' | 'username' | 'display_name' | 'is_admin' | 'disabled' | 'avatar_updated_at' | 'public_storage_bytes'> & { public_gallery_count: number }) | null
  if (!user) return null
  // 已禁用账号视同失效会话：/api/auth/me 返回 null → 前端自动登出
  if (user.disabled === 1) return null

  const publicStorageBytes = Math.max(0, Number(user.public_storage_bytes ?? 0))

  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    isAdmin: user.is_admin === 1,
    avatarUpdatedAt: user.avatar_updated_at,
    maxBatchImages: getDefaultMaxBatchImages(),
    maxConcurrent: proxyQueue.limits().maxConcurrent,
    maxQueue: proxyQueue.limits().maxQueue,
    publicGalleryCount: user.public_gallery_count,
    publicStorageBytes,
    publicStorageQuotaBytes: PER_USER_PUBLIC_QUOTA_BYTES,
  }
}

// 注意：这是「尽力而为」的服务端兜底，只覆盖 /images/generations 的 JSON 请求。
// 图像编辑(/images/edits)、Responses 模式、以及 fan-out（n 张拆成 n 个 n:1 请求）都会绕过它而被记为 1 张；
// 真正在所有模式下一致生效的批量上限是客户端 clamp（见 src/lib/paramCompatibility.ts）。
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

  const baseSegments = target.pathname.split('/').filter(Boolean)
  const endpointSegments = endpointPath.split('/').filter(Boolean)
  // 容忍 API_PROXY_URL 末尾 `/v1` 与请求路径首段重复的情况（如外部工具直接 GET /api-proxy/v1/models），避免拼成 `/v1/v1/...`
  if (
    baseSegments.length > 0
    && endpointSegments.length > 0
    && baseSegments[baseSegments.length - 1] === 'v1'
    && endpointSegments[0] === 'v1'
  ) {
    endpointSegments.shift()
  }
  target.pathname = `/${[...baseSegments, ...endpointSegments].join('/')}`
  target.search = requestUrl.search
  return target
}

function createApiProxyRequestHeaders(c: Context): Headers {
  const headers = new Headers(c.req.raw.headers)
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
  headers.delete('host')
  headers.delete('authorization')
  headers.delete('x-picpilot-authorization')

  if (API_PROXY_API_KEY) {
    headers.set('authorization', `Bearer ${API_PROXY_API_KEY}`)
  }

  return headers
}

function createApiProxyResponseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
  headers.set('Cache-Control', 'no-store')
  return headers
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// ===== app =====

const app = new Hono()

app.use('*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  if (pathname.startsWith('/api/') || pathname.startsWith('/api-proxy/')) return next()
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
  if (user.disabled === 1) {
    return c.json({ error: ACCOUNT_DISABLED_MESSAGE }, 403)
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
  const defaultMaxBatchImages = getDefaultMaxBatchImages()

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
      db.query('INSERT INTO users (id, username, password_hash, is_admin, max_batch_images, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(
        userId, username, hash, defaultMaxBatchImages, now, now,
      )
      db.query('INSERT INTO invite_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)').run(invite, userId, now)
    })()
  } catch (err) {
    if (inviteExhausted) {
      return c.json({ error: '邀请码已用完，请联系管理员重新获取。' }, 400)
    }
    throw err
  }

  const token = await makeToken({ id: userId, username, is_admin: 0, token_version: 0 })
  const profile = getAuthUserPayload(userId)
  if (!profile) return c.json({ error: '注册失败，请稍后重试。' }, 500)
  return c.json({ token, ...profile })
})

app.use('/api/auth/me', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.get('/api/auth/me', (c) => {
  const result = validateSession(c)
  if ('reject' in result) return result.reject
  const profile = getAuthUserPayload(result.row.id)
  if (!profile) return c.json({ error: '登录状态已失效，请重新登录。' }, 401)
  return c.json(profile)
})

// 滑动续期：在当前令牌仍有效（未过期、未禁用、tv 未撤销、未超会话绝对上限）时，
// 换发一枚新的短时令牌，并保留原会话起始时间 sst。前端在过期前定时调用。
app.use('/api/auth/refresh', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.post('/api/auth/refresh', async (c) => {
  const result = validateSession(c)
  if ('reject' in result) return result.reject
  const payload = c.get('jwtPayload') as { sst?: number }
  const now = Math.floor(Date.now() / 1000)
  const sst = typeof payload.sst === 'number' ? payload.sst : now
  if (now - sst > JWT_SESSION_MAX_SECONDS) {
    return c.json({ error: '登录会话已达上限，请重新登录。' }, 401)
  }
  const token = await makeToken(result.row, sst)
  return c.json({ token })
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

  try {
    await writeFile(path.join(AVATARS_DIR, `${payload.sub}.webp`), finalBuffer)
  } catch (err) {
    logger.error({ scope: 'avatar', userId: payload.sub, err: String(err) }, 'Failed to write avatar file')
    return c.json({ error: '保存头像失败，请稍后重试。' }, 500)
  }
  const now = Date.now()
  db.query('UPDATE users SET avatar_updated_at = ? WHERE id = ?').run(now, payload.sub)
  return c.json({ avatarUpdatedAt: now })
})

app.delete('/api/auth/avatar', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  await unlink(path.join(AVATARS_DIR, `${payload.sub}.webp`)).catch(() => {})
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

// 全局并发信号量 + FIFO 等待队列（实现见 concurrencyQueue.ts，handler 只用 acquire/release）。
// 初始上限取「团队服务配置」生效值（管理端配置优先，否则回退环境默认）；管理端改动经 setLimits 实时生效。
const initialLimits = getTeamSettingsPayload()
const proxyQueue = createConcurrencyQueue({
  maxConcurrent: initialLimits.maxConcurrent,
  maxQueue: initialLimits.maxQueue,
  maxWaitMs: PROXY_QUEUE_MAX_WAIT_MS,
})

// SSE 静默期心跳间隔：上游分片之间的安静期超过此值就注入一行注释，保持 socket 活跃。
const PROXY_SSE_HEARTBEAT_MS = Math.max(1000, Number(process.env.PROXY_SSE_HEARTBEAT_MS ?? 15_000))
const PROXY_HEARTBEAT_BYTES = new TextEncoder().encode(': ping\n')

// 转发上游响应体。对 SSE 流，在行边界（上一字节为换行）的静默期注入注释行心跳，
// 规避 Bun idleTimeout（最大 255s）；注释行（: 开头、单换行结尾）会被前端 SSE 解析器忽略，
// 且不含空行，不会提前终止多行事件。完成 / 取消 / 出错时调用 onSettled 释放并发槽位。
function createProxyBodyStream(
  upstreamBody: ReadableStream<Uint8Array>,
  isSse: boolean,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let atLineBoundary = true

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (isSse) {
        heartbeat = setInterval(() => {
          if (!atLineBoundary) return
          try { controller.enqueue(PROXY_HEARTBEAT_BYTES) } catch { /* 已关闭 */ }
        }, PROXY_SSE_HEARTBEAT_MS)
      }
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.length > 0) {
              atLineBoundary = value[value.length - 1] === 0x0a
              controller.enqueue(value)
            }
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        } finally {
          if (heartbeat) clearInterval(heartbeat)
          onSettled()
        }
      })()
    },
    cancel(reason) {
      if (heartbeat) clearInterval(heartbeat)
      onSettled()
      return reader.cancel(reason)
    },
  })
}

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
    return c.json({ error: err instanceof Error ? err.message : 'API 代理配置无效。' }, 500)
  }
  if (!target) return c.json({ error: '上游 API 地址未配置，请联系管理员。' }, 503)

  const payload = c.get('jwtPayload') as { sub: string }
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
  }

  // 并发控制：全局上限 MAX_CONCURRENT，超出则进入 FIFO 队列排队等待。
  try {
    await proxyQueue.acquire(c.req.raw.signal)
  } catch (err) {
    if (err instanceof ClientAbortError) {
      // 客户端在排队期间已断开，无需返回响应体。
      return new Response(null, { status: 499 })
    }
    if (err instanceof QueueFullError) {
      return c.json({ error: '服务繁忙，排队人数过多，请稍后重试。' }, 429)
    }
    // QueueWaitTimeoutError 或其他
    return c.json({ error: '服务繁忙，排队等待超时，请稍后重试。' }, 429)
  }

  let released = false
  const release = () => {
    if (released) return
    released = true
    proxyQueue.release()
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: c.req.method,
      headers: createApiProxyRequestHeaders(c),
      body: c.req.method === 'POST' ? c.req.raw.body : undefined,
      signal: c.req.raw.signal,
      // Bun fetch 默认 300s 超时，到 5 分钟整即抛 TimeoutError；而出图（尤其
      // /images/edits）单次可达 5m40s+，会被这条默认计时器误杀（实测默认 300s、
      // timeout:false 可放行至 310s+）。关闭它，取消完全交给 signal——客户端断开/
      // 取消 → 499，前端 profile.timeout(900s) 兜底；前端 Caddyfile 已配 600s 转发超时。
      timeout: false,
    } as RequestInit)
  } catch (err) {
    release()
    if (c.req.raw.signal.aborted || isAbortLikeError(err)) {
      logger.info({ scope: 'proxy', target: target.href, err: String(err) }, 'API proxy request aborted')
      return new Response(null, { status: 499 })
    }
    logger.error({ scope: 'proxy', target: target.href, err: String(err) }, 'Upstream API request failed')
    return c.json({ error: err instanceof Error ? err.message : '上游 API 请求失败，请稍后重试。' }, 502)
  }

  // 槽位必须保持到响应体完全传输（或客户端取消）为止；否则并发限制只覆盖到首字节，
  // 对流式上游而言整个传输周期都不受约束。
  if (!upstream.body) {
    release()
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: createApiProxyResponseHeaders(upstream),
    })
  }

  const isSse = (upstream.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')
  const monitoredBody = createProxyBodyStream(upstream.body, isSse, release)

  return new Response(monitoredBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: createApiProxyResponseHeaders(upstream),
  })
})

// ===== Queue stats =====
// 暴露全局队列深度，供前端展示「当前 N 个请求排队中」以降低排队焦虑。
// 只读全局计数（O(1)、无 DB）；上限本就经 /api/auth/me 公开，仅做 JWT 校验防匿名探测容量。
app.use('/api/queue/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.get('/api/queue/stats', (c) => {
  const { inflight, queued } = proxyQueue.stats()
  const { maxConcurrent, maxQueue } = proxyQueue.limits()
  return c.json({ inflight, queued, maxConcurrent, maxQueue })
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

  if ('defaultMaxBatchImages' in record) {
    const val = parseBatchImageLimitPatchValue(record.defaultMaxBatchImages)
    if (val == null) return c.json({ error: '默认批量上限必须是 1 到 100 之间的数字。' }, 400)
    settings.defaultMaxBatchImages = val
    hasUpdates = true
  }

  if ('maxConcurrent' in record) {
    const val = parseConcurrencyPatchValue(record.maxConcurrent)
    if (val == null) return c.json({ error: '团队并发必须是 1 到 100 之间的数字。' }, 400)
    settings.maxConcurrent = val
    hasUpdates = true
  }

  if ('maxQueue' in record) {
    const val = parseQueuePatchValue(record.maxQueue)
    if (val == null) return c.json({ error: '排队上限必须是 0 到 1000 之间的数字。' }, 400)
    settings.maxQueue = val
    hasUpdates = true
  }

  if (!hasUpdates) return c.json({ error: '没有可更新的字段。' }, 400)
  saveTeamSettingsRecord(settings, payload.sub)
  // 立即把新上限应用到在跑的队列，无需重启 auth 容器。
  const effective = getTeamSettingsPayload()
  proxyQueue.setLimits({ maxConcurrent: effective.maxConcurrent, maxQueue: effective.maxQueue })
  logger.info({ scope: 'admin', updatedBy: payload.sub, maxConcurrent: effective.maxConcurrent, maxQueue: effective.maxQueue }, 'Team service limits updated')
  return c.json(effective)
})

app.get('/api/admin/users', (c) => {
  const rows = db.query(`
    SELECT u.id, u.username, u.is_admin, u.disabled, u.max_batch_images, u.created_at, u.last_login_at,
           u.avatar_updated_at,
           s.total_requests, s.success_count, s.failure_count,
           s.last_request_at,
           s.total_duration_ms, s.total_output_bytes
    FROM users u
    LEFT JOIN user_stats s ON s.user_id = u.id
    ORDER BY u.created_at DESC
  `).all()
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
  if (body.disabled === true) {
    if (id === payload.sub) {
      return c.json({ error: '不能禁用当前登录的账号。' }, 400)
    }
    const target = db.query('SELECT is_admin FROM users WHERE id = ?').get(id) as { is_admin: number } | null
    if (target?.is_admin === 1) {
      const activeAdmins = (db.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as { n: number }).n
      if (activeAdmins <= 1) {
        return c.json({ error: '至少需要保留一个启用的管理员，无法禁用最后一个管理员。' }, 400)
      }
    }
  }
  const updates: string[] = []
  const args: SQLQueryBindings[] = []
  if (typeof body.isAdmin === 'boolean') { updates.push('is_admin = ?'); args.push(body.isAdmin ? 1 : 0) }
  if (typeof body.disabled === 'boolean') { updates.push('disabled = ?'); args.push(body.disabled ? 1 : 0) }
  if (typeof body.password === 'string' && body.password.length >= 6) {
    updates.push('password_hash = ?')
    args.push(await Bun.password.hash(body.password, { algorithm: 'bcrypt', cost: 10 }))
    // 改密码即令该用户所有旧令牌失效（全设备登出）
    updates.push('token_version = token_version + 1')
  }
  if (updates.length === 0) return c.json({ error: '没有可更新的字段。' }, 400)
  args.push(id)
  const result = db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...(args))
  if (result.changes === 0) return c.json({ error: '用户不存在，可能已被删除。' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/admin/users/:id', async (c) => {
  const id = c.req.param('id')
  const payload = c.get('jwtPayload') as { sub: string }
  if (id === payload.sub) return c.json({ error: '不能删除当前登录的管理员账号。' }, 400)

  const imgs = db.query('SELECT id FROM public_images WHERE user_id = ?').all(id) as Array<{ id: string }>
  await Promise.allSettled(imgs.map((img) => deletePublicImageFiles(img.id)))

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
  const maxUses = Math.max(1, Math.min(INVITE_MAX_USES, Number(body.maxUses ?? 1)))
  const count = Math.max(1, Math.min(INVITE_MAX_BATCH_COUNT, Number(body.count ?? 1)))
  const note = typeof body.note === 'string' ? body.note.slice(0, INVITE_NOTE_MAX_LEN) : null
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
  const args: SQLQueryBindings[] = []
  if (userId) { where.push('user_id = ?'); args.push(userId) }
  if (eventType) { where.push('event_type = ?'); args.push(eventType) }
  if (errorType) { where.push('error_type = ?'); args.push(errorType) }
  if (since) { where.push('created_at >= ?'); args.push(since) }
  if (until) { where.push('created_at <= ?'); args.push(until) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const events = db.query(`
    SELECT * FROM request_events ${whereSql}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...(args), limit, offset)
  const total = (db.query(`SELECT COUNT(*) AS n FROM request_events ${whereSql}`).get(...(args)) as { n: number }).n

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
  const args: SQLQueryBindings[] = [since, until]
  if (userId) { where.push('user_id = ?'); args.push(userId) }
  if (eventType) { where.push('event_type = ?'); args.push(eventType) }
  if (errorType) { where.push('error_type = ?'); args.push(errorType) }
  const whereSql = `WHERE ${where.join(' AND ')}`

  const rows = db.query(`
    SELECT * FROM request_events ${whereSql} ORDER BY created_at ASC
  `).all(...(args)) as Array<Record<string, unknown>>

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

  await deletePublicImageFiles(id)

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

// 管理员设置 / 取消共享画廊「推荐」
app.post('/api/admin/gallery/:id/feature', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string; username: string }
  const id = c.req.param('id')
  const exists = db.query('SELECT 1 FROM public_images WHERE id = ?').get(id)
  if (!exists) return c.json({ error: '图片不存在，可能已被删除。' }, 404)

  const body = await c.req.json().catch(() => ({})) as { featured?: unknown }
  const featured = body.featured === true || body.featured === 1 ? 1 : 0
  db.query('UPDATE public_images SET featured = ? WHERE id = ?').run(featured, id)

  logger.info({ scope: 'admin', actor: payload.username, imageId: id, featured: featured === 1 }, 'Gallery image featured toggled')
  return c.json({ ok: true, featured: featured === 1 })
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

  // 预检：已超额则快速失败，省去白做 sharp 处理。真正的并发安全由下方事务内的二次校验保证（见提交处注释）。
  const used = (db.query('SELECT public_storage_bytes AS bytes FROM users WHERE id = ?').get(payload.sub) as { bytes: number } | null)?.bytes ?? 0
  if (used >= PER_USER_PUBLIC_QUOTA_BYTES) {
    return c.json({ error: '公开画廊空间已用完，请先删除一些公开图片后再上传。' }, 413)
  }

  const body = await c.req.json().catch(() => null) as { image_base64?: string; prompt?: string; originals?: unknown[] } | null
  if (!body || typeof body.image_base64 !== 'string' || typeof body.prompt !== 'string') {
    return c.json({ error: '请提供要公开的图片和提示词。' }, 400)
  }

  const rawOriginals = Array.isArray(body.originals)
    ? body.originals.filter((o): o is string => typeof o === 'string').slice(0, MAX_PUBLIC_ORIGINALS)
    : []

  // 主图必处理；处理失败直接报错。原图（@引用的输入图）尽量随主图一起公开，单张处理失败则跳过。
  let main: ProcessedPublicImage
  try {
    main = await processPublicImage(body.image_base64)
  } catch (e) {
    if (e instanceof PublicImageTooLargeError) return c.json({ error: '图片过大，请上传 50MB 以内的图片。' }, 413)
    return c.json({ error: '无法处理这张图片，请换一张试试。' }, 400)
  }

  const originals: ProcessedPublicImage[] = []
  for (const raw of rawOriginals) {
    try {
      originals.push(await processPublicImage(raw))
    } catch {
      // 原图处理失败不影响主图公开，静默跳过
    }
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  // 主图 + 原图占用的总空间都计入用户配额（写入主图 file_size，删除/撤下时按此回收）
  const totalBytes = main.finalBuffer.length + originals.reduce((sum, o) => sum + o.finalBuffer.length, 0)

  try {
    await Promise.all([
      writeFile(path.join(PUBLIC_DIR, `${id}.webp`), main.finalBuffer),
      writeFile(path.join(THUMBS_DIR, `${id}.webp`), main.thumbBuffer),
      ...originals.flatMap((o) => [
        writeFile(path.join(PUBLIC_DIR, `${o.id}.webp`), o.finalBuffer),
        writeFile(path.join(THUMBS_DIR, `${o.id}.webp`), o.thumbBuffer),
      ]),
    ])
  } catch (err) {
    logger.error({ scope: 'gallery', userId: payload.sub, imageId: id, err: String(err) }, 'Gallery publish failed writing files')
    await cleanupPublicImageFiles(id, originals.map((o) => o.id))
    return c.json({ error: '公开图片失败，请稍后重试。' }, 500)
  }

  // body.prompt 已在上面的类型守卫里证明是 string，但该窄化无法带进事务闭包，先在此处提取。
  const promptText = body.prompt.slice(0, 4000)
  // 配额二次校验 + 三条写库放进同一个同步事务：bun:sqlite 事务同步执行、SQLite 写事务串行化，
  // 事务内重读 public_storage_bytes 即为序列化点，杜绝「两请求都通过预检后双双提交」的超额竞态。
  let quotaExceeded = false
  try {
    db.transaction(() => {
      const cur = db.query('SELECT public_storage_bytes AS bytes FROM users WHERE id = ?').get(payload.sub) as { bytes: number } | null
      if (!cur) throw new Error('user not found')
      if (cur.bytes + totalBytes > PER_USER_PUBLIC_QUOTA_BYTES) {
        quotaExceeded = true
        throw new Error('quota exceeded')
      }
      db.query(`
        INSERT INTO public_images (id, user_id, prompt, width, height, file_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, payload.sub, promptText, main.width ?? null, main.height ?? null, totalBytes, now)
      originals.forEach((o, i) => {
        db.query(`
          INSERT INTO public_image_originals (id, image_id, position, width, height, file_size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(o.id, id, i, o.width ?? null, o.height ?? null, o.finalBuffer.length, now)
      })
      db.query('UPDATE users SET public_storage_bytes = public_storage_bytes + ? WHERE id = ?').run(totalBytes, payload.sub)
    })()
  } catch (err) {
    // 事务已回滚（DB 无记录），但文件已落盘 → 用内存里的 id 清理，避免孤儿文件。
    // 不能复用 deletePublicImageFiles：它查 DB 找原图，而此时事务已回滚、查不到。
    await cleanupPublicImageFiles(id, originals.map((o) => o.id))
    if (quotaExceeded) {
      return c.json({ error: '公开画廊空间已用完，请先删除一些公开图片后再上传。' }, 413)
    }
    logger.error({ scope: 'gallery', userId: payload.sub, imageId: id, err: String(err) }, 'Gallery publish transaction failed; rolled back and cleaned files')
    return c.json({ error: '公开图片失败，请稍后重试。' }, 500)
  }

  return c.json({ id, width: main.width, height: main.height, size: totalBytes, originals: originals.length })
})

app.get('/api/gallery', (c) => {
  const limit = Math.min(60, Math.max(1, Number(c.req.query('limit') ?? 24)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const userId = c.req.query('user_id')

  const where = userId ? 'WHERE p.user_id = ?' : ''
  const args: SQLQueryBindings[] = userId ? [userId] : []
  const images = db.query(`
    SELECT p.id, p.user_id,
           u.username,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name,
           u.avatar_updated_at,
           p.prompt, p.width, p.height, p.file_size, p.created_at, p.featured
    FROM public_images p
    JOIN users u ON u.id = p.user_id
    ${where}
    ORDER BY p.featured DESC, p.created_at DESC LIMIT ? OFFSET ?
  `).all(...(args), limit, offset)
  const total = (db.query(`SELECT COUNT(*) AS n FROM public_images p ${where}`).get(...(args)) as { n: number }).n

  // 一次性查出本页所有公开图的原图，按 position 归到各自主图下
  const imageIds = (images as Array<{ id: string }>).map((img) => img.id)
  const originalsByImage = new Map<string, Array<{ id: string; width: number | null; height: number | null }>>()
  if (imageIds.length > 0) {
    const placeholders = imageIds.map(() => '?').join(',')
    const rows = db.query(`
      SELECT id, image_id, width, height
      FROM public_image_originals
      WHERE image_id IN (${placeholders})
      ORDER BY position ASC
    `).all(...(imageIds)) as Array<{ id: string; image_id: string; width: number | null; height: number | null }>
    for (const row of rows) {
      const list = originalsByImage.get(row.image_id) ?? []
      list.push({ id: row.id, width: row.width, height: row.height })
      originalsByImage.set(row.image_id, list)
    }
  }
  const withOriginals = (images as Array<{ id: string }>).map((img) => ({
    ...img,
    originals: originalsByImage.get(img.id) ?? [],
  }))

  return c.json({ images: withOriginals, total })
})

app.delete('/api/gallery/:id', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const id = c.req.param('id')
  const img = db.query('SELECT user_id, file_size FROM public_images WHERE id = ?').get(id) as { user_id: string; file_size: number | null } | null
  if (!img) return c.json({ error: '图片不存在，可能已被删除。' }, 404)

  if (img.user_id !== payload.sub) return c.json({ error: '无权删除这张图片。' }, 403)

  await deletePublicImageFiles(id)
  db.transaction(() => {
    db.query('DELETE FROM public_images WHERE id = ?').run(id)
    if (img.file_size) {
      db.query('UPDATE users SET public_storage_bytes = MAX(0, public_storage_bytes - ?) WHERE id = ?').run(img.file_size, img.user_id)
    }
  })()
  // 返回删除后的占用 / 张数，前端据此本地更新，避免再发一轮 /api/me 全量刷新
  const storageBytes = (db.query('SELECT public_storage_bytes AS bytes FROM users WHERE id = ?').get(img.user_id) as { bytes: number } | null)?.bytes ?? 0
  const galleryCount = (db.query('SELECT COUNT(*) AS n FROM public_images WHERE user_id = ?').get(img.user_id) as { n: number }).n
  return c.json({ ok: true, storageBytes, galleryCount })
})

// 鉴权后流式返回公开图（原图或缩略图）
app.get('/api/gallery/image/:id', (c) => {
  const id = c.req.param('id')
  const isThumb = c.req.query('thumb') === '1'
  const exists = db.query('SELECT 1 FROM public_images WHERE id = ? UNION ALL SELECT 1 FROM public_image_originals WHERE id = ? LIMIT 1').get(id, id)
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

// 仅作为主进程（bun run index.ts）启动时才监听端口；测试 import 本模块拿到 { app, db }
// 用 app.request(...) 在进程内驱动，不会占用端口。
if (import.meta.main) {
  const server = Bun.serve({
    fetch: app.fetch,
    port: PORT,
    // 图像生成 / Agent 的流式响应在分片之间可能出现较长静默（上游 cliproxyapi 代理的 CLI 后端
    // 在生成大图时会安静一段时间）。Bun 默认 10s 空闲超时会在静默期直接断开 socket，导致前端
    // fetch 抛出 "network error"。上调到 Bun 允许的最大值 255s，由 Caddy 的 600s 读写超时兜底。
    idleTimeout: 255,
  })

  logger.info({ scope: 'server', url: server.url.href.replace(/\/$/, '') }, 'picpilot ready')
  logger.info({
    scope: 'server',
    port: PORT,
    staticDir: STATIC_DIR,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    apiProxy: Boolean(API_PROXY_URL),
    maxConcurrent: MAX_CONCURRENT,
    maxQueue: PROXY_QUEUE_MAX,
    maxQueueWaitMs: PROXY_QUEUE_MAX_WAIT_MS,
    defaultMaxBatchImages: DEFAULT_MAX_BATCH_IMAGES,
  }, 'Runtime configuration')
}

// 供集成测试用 app.request 在进程内驱动，并直接读/写 db 做断言与种子数据。
export { app, db }
