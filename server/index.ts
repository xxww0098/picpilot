import { Hono, type Context, type Next } from 'hono'
import { jwt as jwtMiddleware, sign as jwtSign } from 'hono/jwt'
import { Database } from 'bun:sqlite'
import sharp from 'sharp'
import path from 'path'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { writeFile } from 'fs/promises'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.AUTH_PORT ?? '3001')
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN_SECONDS = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 30 * 24 * 60 * 60)
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../data')
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'auth.db')
const PUBLIC_DIR = path.join(DATA_DIR, 'public')
const THUMBS_DIR = path.join(PUBLIC_DIR, 'thumbs')
const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS ?? 30)
const PER_USER_PUBLIC_QUOTA_BYTES = Number(process.env.PER_USER_PUBLIC_QUOTA_BYTES ?? 500 * 1024 * 1024)
const MAX_IMAGE_LONG_EDGE = 2048
const THUMB_LONG_EDGE = 256

if (!JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET environment variable is required.')
  process.exit(1)
}

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(PUBLIC_DIR, { recursive: true })
mkdirSync(THUMBS_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
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
    first_request_at   INTEGER,
    last_request_at    INTEGER,
    last_success_at    INTEGER,
    last_failure_at    INTEGER,
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
    username   TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    width      INTEGER,
    height     INTEGER,
    file_size  INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_public_created ON public_images(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_public_user ON public_images(user_id);
`)

// 兼容旧 schema：早期 users 表没有 is_admin 字段
const userCols = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name)
if (!userCols.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
}

// ===== seeding =====

interface UserRow {
  id: string
  username: string
  password_hash: string
  is_admin: number
  created_at: number
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
    db.query('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(),
      username,
      hash,
      isAdmin ? 1 : 0,
      Date.now(),
    )
    console.log(`[auth] Seeded ${isAdmin ? 'admin' : 'user'}: ${username}`)
  }
}

await seedAdmins(process.env.ADMIN_USERS, true)
await seedAdmins(process.env.AUTH_USERS, false)

const adminCount = (db.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n
if (adminCount === 0) {
  console.warn('[auth] WARNING: no admin users. Set ADMIN_USERS="name:password" to bootstrap.')
}

// 30 天事件清理
function purgeOldEvents() {
  const cutoff = Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const result = db.query('DELETE FROM request_events WHERE created_at < ?').run(cutoff)
  if (result.changes > 0) console.log(`[telemetry] Purged ${result.changes} events older than ${EVENT_RETENTION_DAYS}d`)
}
purgeOldEvents()
setInterval(purgeOldEvents, 24 * 60 * 60 * 1000)

// ===== 工具 =====

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

function makeToken(user: { id: string; username: string; is_admin: number }): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN_SECONDS
  return jwtSign({ sub: user.id, username: user.username, isAdmin: user.is_admin === 1, exp }, JWT_SECRET!)
}

async function requireAdmin(c: Context, next: Next) {
  const payload = c.get('jwtPayload') as { sub: string }
  const user = db.query('SELECT is_admin FROM users WHERE id = ?').get(payload.sub) as { is_admin: number } | null
  if (!user || user.is_admin !== 1) return c.json({ error: '需要管理员权限' }, 403)
  return next()
}

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 12; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

// ===== app =====

const app = new Hono()

// ===== Auth =====

app.post('/api/auth/login', async (c) => {
  if (isRateLimited(getClientIp(c))) {
    return c.json({ error: '登录失败次数过多，请稍后再试' }, 429)
  }

  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password) return c.json({ error: '请提供用户名和密码' }, 400)

  const user = db.query('SELECT * FROM users WHERE username = ?').get(username) as UserRow | null
  if (!user || !(await Bun.password.verify(password, user.password_hash))) {
    return c.json({ error: '用户名或密码错误' }, 401)
  }

  const token = await makeToken(user)
  return c.json({ token, userId: user.id, username: user.username, isAdmin: user.is_admin === 1 })
})

app.post('/api/auth/register', async (c) => {
  if (isRateLimited(getClientIp(c))) {
    return c.json({ error: '请求过于频繁' }, 429)
  }

  const { invite, username, password } = await c.req.json().catch(() => ({}))
  if (!invite || !username || !password) return c.json({ error: '请提供邀请码、用户名和密码' }, 400)
  if (username.length < 2 || username.length > 32) return c.json({ error: '用户名长度需在 2-32 之间' }, 400)
  if (password.length < 6) return c.json({ error: '密码至少 6 位' }, 400)

  interface InviteRow {
    code: string
    expires_at: number | null
    max_uses: number
    used_count: number
  }
  const code = db.query('SELECT * FROM invite_codes WHERE code = ?').get(invite) as InviteRow | null
  if (!code) return c.json({ error: '邀请码无效' }, 400)
  if (code.expires_at && code.expires_at < Date.now()) return c.json({ error: '邀请码已过期' }, 400)
  if (code.used_count >= code.max_uses) return c.json({ error: '邀请码已用完' }, 400)

  if (db.query('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return c.json({ error: '用户名已被占用' }, 409)
  }

  const userId = crypto.randomUUID()
  const now = Date.now()
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })

  db.transaction(() => {
    db.query('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)').run(
      userId, username, hash, now,
    )
    db.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?').run(invite)
    db.query('INSERT INTO invite_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)').run(invite, userId, now)
  })()

  const token = await makeToken({ id: userId, username, is_admin: 0 })
  return c.json({ token, userId, username, isAdmin: false })
})

app.use('/api/auth/me', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.get('/api/auth/me', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const user = db.query('SELECT id, username, is_admin FROM users WHERE id = ?').get(payload.sub) as Pick<UserRow, 'id' | 'username' | 'is_admin'> | null
  if (!user) return c.json({ error: '用户不存在' }, 401)
  return c.json({ userId: user.id, username: user.username, isAdmin: user.is_admin === 1 })
})

// ===== Telemetry =====

app.use('/api/telemetry/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.post('/api/telemetry/event', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string; username: string }
  const e = await c.req.json().catch(() => null)
  if (!e || !e.event_type) return c.json({ error: 'invalid event' }, 400)

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
      payload.sub, payload.username, e.event_type,
      e.provider ?? null, e.api_mode ?? null, e.model ?? null, e.size ?? null, e.quality ?? null, e.n_images ?? null,
      e.has_input_image ? 1 : 0, e.input_image_count ?? null, e.has_mask ? 1 : 0,
      e.prompt ?? null, e.duration_ms ?? null, e.http_status ?? null,
      e.error_type ?? null, e.error_message ?? null, e.error_stack ?? null,
      e.output_count ?? null, e.output_bytes ?? null,
      c.req.header('user-agent') ?? null, getClientIp(c), e.client_version ?? null, now,
    )

    db.query(`
      INSERT INTO user_stats (
        user_id, total_requests, success_count, failure_count,
        first_request_at, last_request_at, last_success_at, last_failure_at,
        total_duration_ms, total_output_bytes
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        total_requests     = total_requests + 1,
        success_count      = success_count + excluded.success_count,
        failure_count      = failure_count + excluded.failure_count,
        last_request_at    = excluded.last_request_at,
        last_success_at    = COALESCE(excluded.last_success_at, last_success_at),
        last_failure_at    = COALESCE(excluded.last_failure_at, last_failure_at),
        total_duration_ms  = total_duration_ms + excluded.total_duration_ms,
        total_output_bytes = total_output_bytes + excluded.total_output_bytes
    `).run(
      payload.sub,
      isSuccess ? 1 : 0,
      isFailure ? 1 : 0,
      now, now,
      isSuccess ? now : null,
      isFailure ? now : null,
      e.duration_ms ?? 0,
      e.output_bytes ?? 0,
    )
  })()

  return c.json({ ok: true })
})

// ===== Admin =====

app.use('/api/admin/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))
app.use('/api/admin/*', requireAdmin)

app.get('/api/admin/users', (c) => {
  const rows = db.query(`
    SELECT u.id, u.username, u.is_admin, u.created_at,
           s.total_requests, s.success_count, s.failure_count,
           s.first_request_at, s.last_request_at, s.last_success_at, s.last_failure_at,
           s.total_duration_ms, s.total_output_bytes
    FROM users u
    LEFT JOIN user_stats s ON s.user_id = u.id
    ORDER BY u.created_at DESC
  `).all()
  return c.json({ users: rows })
})

app.patch('/api/admin/users/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const updates: string[] = []
  const args: unknown[] = []
  if (typeof body.isAdmin === 'boolean') { updates.push('is_admin = ?'); args.push(body.isAdmin ? 1 : 0) }
  if (typeof body.password === 'string' && body.password.length >= 6) {
    updates.push('password_hash = ?')
    args.push(await Bun.password.hash(body.password, { algorithm: 'bcrypt', cost: 10 }))
  }
  if (updates.length === 0) return c.json({ error: '无可更新字段' }, 400)
  args.push(id)
  const result = db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...(args as never[]))
  if (result.changes === 0) return c.json({ error: '用户不存在' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/admin/users/:id', (c) => {
  const id = c.req.param('id')
  const payload = c.get('jwtPayload') as { sub: string }
  if (id === payload.sub) return c.json({ error: '不能删除自己' }, 400)

  const imgs = db.query('SELECT id FROM public_images WHERE user_id = ?').all(id) as Array<{ id: string }>
  for (const img of imgs) {
    try { unlinkSync(path.join(PUBLIC_DIR, `${img.id}.webp`)) } catch {}
    try { unlinkSync(path.join(THUMBS_DIR, `${img.id}.webp`)) } catch {}
  }

  const result = db.query('DELETE FROM users WHERE id = ?').run(id)
  if (result.changes === 0) return c.json({ error: '用户不存在' }, 404)
  return c.json({ ok: true })
})

app.get('/api/admin/invites', (c) => {
  const rows = db.query(`
    SELECT c.*, u.username AS creator_username
    FROM invite_codes c
    LEFT JOIN users u ON u.id = c.created_by
    ORDER BY c.created_at DESC
  `).all()
  return c.json({ invites: rows })
})

app.post('/api/admin/invites', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const body = await c.req.json().catch(() => ({}))
  const maxUses = Math.max(1, Math.min(1000, Number(body.maxUses ?? 1)))
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null
  const expiresAt = body.expiresAt ? Number(body.expiresAt) : null

  const code = generateInviteCode()
  db.query(`
    INSERT INTO invite_codes (code, created_by, created_at, expires_at, max_uses, used_count, note)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(code, payload.sub, Date.now(), expiresAt, maxUses, note)

  return c.json({ code })
})

app.delete('/api/admin/invites/:code', (c) => {
  const code = c.req.param('code')
  const result = db.query('DELETE FROM invite_codes WHERE code = ?').run(code)
  if (result.changes === 0) return c.json({ error: '邀请码不存在' }, 404)
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

// ===== Gallery =====

app.use('/api/gallery/*', jwtMiddleware({ secret: JWT_SECRET!, alg: 'HS256' }))

app.post('/api/gallery', async (c) => {
  const payload = c.get('jwtPayload') as { sub: string; username: string }

  const used = (db.query('SELECT COALESCE(SUM(file_size), 0) AS bytes FROM public_images WHERE user_id = ?').get(payload.sub) as { bytes: number }).bytes
  if (used >= PER_USER_PUBLIC_QUOTA_BYTES) {
    return c.json({ error: '已超过公开图配额，请先删除一些再上传' }, 413)
  }

  const body = await c.req.json().catch(() => null) as { image_base64?: string; prompt?: string } | null
  if (!body || typeof body.image_base64 !== 'string' || typeof body.prompt !== 'string') {
    return c.json({ error: '请提供 image_base64 和 prompt' }, 400)
  }

  const base64 = body.image_base64.replace(/^data:image\/[a-z]+;base64,/, '')
  const inputBuffer = Buffer.from(base64, 'base64')
  if (inputBuffer.length > 50 * 1024 * 1024) return c.json({ error: '图片过大（>50MB）' }, 413)

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

  db.query(`
    INSERT INTO public_images (id, user_id, username, prompt, width, height, file_size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, payload.sub, payload.username, body.prompt.slice(0, 4000), finalMeta.width ?? null, finalMeta.height ?? null, finalBuffer.length, Date.now())

  return c.json({ id, width: finalMeta.width, height: finalMeta.height, size: finalBuffer.length })
})

app.get('/api/gallery', (c) => {
  const limit = Math.min(60, Math.max(1, Number(c.req.query('limit') ?? 24)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const userId = c.req.query('user_id')

  const where = userId ? 'WHERE user_id = ?' : ''
  const args = userId ? [userId] : []
  const images = db.query(`
    SELECT id, user_id, username, prompt, width, height, file_size, created_at
    FROM public_images ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...(args as never[]), limit, offset)
  const total = (db.query(`SELECT COUNT(*) AS n FROM public_images ${where}`).get(...(args as never[])) as { n: number }).n
  return c.json({ images, total })
})

app.delete('/api/gallery/:id', (c) => {
  const payload = c.get('jwtPayload') as { sub: string }
  const id = c.req.param('id')
  const img = db.query('SELECT user_id FROM public_images WHERE id = ?').get(id) as { user_id: string } | null
  if (!img) return c.json({ error: '图片不存在' }, 404)

  const me = db.query('SELECT is_admin FROM users WHERE id = ?').get(payload.sub) as { is_admin: number } | null
  if (img.user_id !== payload.sub && me?.is_admin !== 1) return c.json({ error: '无权删除' }, 403)

  try { unlinkSync(path.join(PUBLIC_DIR, `${id}.webp`)) } catch {}
  try { unlinkSync(path.join(THUMBS_DIR, `${id}.webp`)) } catch {}
  db.query('DELETE FROM public_images WHERE id = ?').run(id)
  return c.json({ ok: true })
})

// 鉴权后流式返回公开图（原图或缩略图）
app.get('/api/gallery/image/:id', (c) => {
  const id = c.req.param('id')
  const isThumb = c.req.query('thumb') === '1'
  const exists = db.query('SELECT 1 FROM public_images WHERE id = ?').get(id)
  if (!exists) return c.json({ error: '图片不存在' }, 404)

  const file = path.join(isThumb ? THUMBS_DIR : PUBLIC_DIR, `${id}.webp`)
  if (!existsSync(file)) return c.json({ error: '图片文件丢失' }, 404)

  // Bun.file 直接当 Response body，零拷贝
  return new Response(Bun.file(file), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(statSync(file).size),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
})

// ===== boot =====

console.log(`[auth] Auth server running on :${PORT}`)
export default {
  fetch: app.fetch,
  port: PORT,
}
