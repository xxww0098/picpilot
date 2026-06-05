// 进程内集成测试：import 本模块拿到 { app, db }，用 app.request 驱动 HTTP 层（不占端口）。
// 必须在 import ./index.ts / ./config.ts 之前设置环境变量——config.ts 在导入时读取并固化它们。
// 放在 server/ 根目录（非 utils/），不会被 Dockerfile 的 COPY 打进生产镜像。
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'picpilot-itest-'))
process.env.JWT_SECRET = 'integration-test-secret-key-0123456789abcdef'
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = TMP_DATA_DIR
process.env.LOG_LEVEL = 'silent'
// 不覆盖 PER_USER_PUBLIC_QUOTA_BYTES：用默认值，配额测试通过种子 public_storage_bytes 逼近上限实现。

const { app, db } = await import('./index.ts')
const { PER_USER_PUBLIC_QUOTA_BYTES, PUBLIC_DIR, THUMBS_DIR } = await import('./config.ts')
const { sign } = await import('hono/jwt')

const SECRET = process.env.JWT_SECRET!
// 1×1 透明 PNG（base64），sharp 可解码、处理后体积很小且稳定。
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function tokenFor(userId: string, username: string, isAdmin = false, opts: { tv?: number; sst?: number; exp?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { sub: userId, username, isAdmin, tv: opts.tv ?? 0, sst: opts.sst ?? now, exp: opts.exp ?? now + 3600 },
    SECRET,
  )
}

function seedUser(id: string, username: string, bytes = 0): void {
  db.query(
    'INSERT INTO users (id, username, password_hash, created_at, public_storage_bytes) VALUES (?, ?, ?, ?, ?)',
  ).run(id, username, 'x', Date.now(), bytes)
}

function getBytes(userId: string): number {
  return (db.query('SELECT public_storage_bytes AS b FROM users WHERE id = ?').get(userId) as { b: number } | null)?.b ?? 0
}

function publish(token: string, prompt = 'hello') {
  return app.request('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_base64: TINY_PNG_BASE64, prompt }),
  })
}

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true })
})

test('未带 JWT 访问画廊返回 401', async () => {
  const res = await app.request('/api/gallery', { method: 'GET' })
  expect(res.status).toBe(401)
})

test('发布公开图成功，配额精确累加，文件落盘', async () => {
  seedUser('u-success', 'alice')
  const token = await tokenFor('u-success', 'alice')
  const res = await publish(token)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: string; size: number }
  expect(typeof body.id).toBe('string')
  expect(body.size).toBeGreaterThan(0)
  expect(getBytes('u-success')).toBe(body.size)
  expect(existsSync(path.join(PUBLIC_DIR, `${body.id}.webp`))).toBe(true)
  expect(existsSync(path.join(THUMBS_DIR, `${body.id}.webp`))).toBe(true)
})

test('删除自己的公开图：回收配额、删除文件、返回最新占用与张数', async () => {
  seedUser('u-del', 'bob')
  const token = await tokenFor('u-del', 'bob')
  const pub = (await (await publish(token)).json()) as { id: string }
  const res = await app.request(`/api/gallery/${pub.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { storageBytes: number; galleryCount: number }
  expect(body.storageBytes).toBe(0)
  expect(body.galleryCount).toBe(0)
  expect(existsSync(path.join(PUBLIC_DIR, `${pub.id}.webp`))).toBe(false)
})

test('发布缺少字段返回 400', async () => {
  seedUser('u-bad', 'carol')
  const token = await tokenFor('u-bad', 'carol')
  const res = await app.request('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt: 'no image' }),
  })
  expect(res.status).toBe(400)
})

test('并发发布达上限时严格原子：恰好一个 200、一个 413，配额不超额且无孤儿文件', async () => {
  // 先发一张拿到处理后体积 S（同一输入图 → 处理后体积确定）
  seedUser('u-probe', 'dave')
  const probe = (await (await publish(await tokenFor('u-probe', 'dave'))).json()) as { size: number }
  const S = probe.size
  expect(S).toBeGreaterThan(0)

  // 把 race 用户的占用逼到 QUOTA - S：只够再发一张，第二张应被事务内二次校验挡下
  seedUser('u-race', 'erin', PER_USER_PUBLIC_QUOTA_BYTES - S)
  const token = await tokenFor('u-race', 'erin')

  const [a, b] = await Promise.all([publish(token), publish(token)])
  expect([a.status, b.status].sort()).toEqual([200, 413])
  // 配额恰好顶到上限、绝不超额
  expect(getBytes('u-race')).toBe(PER_USER_PUBLIC_QUOTA_BYTES)
  // race 用户只应留下 1 张成功的图
  const ownerImages = db.query('SELECT id FROM public_images WHERE user_id = ?').all('u-race') as Array<{ id: string }>
  expect(ownerImages.length).toBe(1)

  // 全局不变量：磁盘上的 .webp 数 == DB 记录数（主图 + 原图）——被拒上传写下的文件已被回滚清理，无孤儿
  const mainCount = (db.query('SELECT COUNT(*) AS n FROM public_images').get() as { n: number }).n
  const origCount = (db.query('SELECT COUNT(*) AS n FROM public_image_originals').get() as { n: number }).n
  const fileCount = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.webp')).length
  expect(fileCount).toBe(mainCount + origCount)
})

// ===== 认证流（register / login / me / 限速）=====

function seedInvite(code: string, opts: { maxUses?: number; expiresAt?: number | null } = {}): void {
  db.query(
    'INSERT INTO invite_codes (code, created_by, created_at, expires_at, max_uses, used_count, note) VALUES (?, ?, ?, ?, ?, 0, ?)',
  ).run(code, 'seed-admin', Date.now(), opts.expiresAt ?? null, opts.maxUses ?? 5, null)
}

// 每个用例传不同 ip（x-real-ip），隔离登录限速计数，避免相互干扰
function authPost(path: string, body: unknown, ip: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  })
}

test('注册 → 登录 → 读取资料（happy path）', async () => {
  seedInvite('INVITE-OK', { maxUses: 5 })
  const reg = await authPost('/api/auth/register', { invite: 'INVITE-OK', username: 'newuser', password: 'secret123' }, '10.0.0.1')
  expect(reg.status).toBe(200)
  expect(typeof ((await reg.json()) as { token: string }).token).toBe('string')

  const login = await authPost('/api/auth/login', { username: 'newuser', password: 'secret123' }, '10.0.0.1')
  expect(login.status).toBe(200)
  const loginBody = (await login.json()) as { token: string }
  expect(typeof loginBody.token).toBe('string')

  const me = await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${loginBody.token}` } })
  expect(me.status).toBe(200)
  expect(((await me.json()) as { username: string }).username).toBe('newuser')
})

test('无效邀请码注册被拒（400）', async () => {
  const res = await authPost('/api/auth/register', { invite: 'NOPE', username: 'bad1', password: 'secret123' }, '10.0.0.2')
  expect(res.status).toBe(400)
})

test('密码过短注册被拒（400）', async () => {
  seedInvite('INVITE-SHORT')
  const res = await authPost('/api/auth/register', { invite: 'INVITE-SHORT', username: 'bad2', password: '123' }, '10.0.0.3')
  expect(res.status).toBe(400)
})

test('用户名重复注册被拒（409）', async () => {
  seedInvite('INVITE-DUP', { maxUses: 5 })
  const a = await authPost('/api/auth/register', { invite: 'INVITE-DUP', username: 'dupuser', password: 'secret123' }, '10.0.0.4')
  expect(a.status).toBe(200)
  const b = await authPost('/api/auth/register', { invite: 'INVITE-DUP', username: 'dupuser', password: 'secret123' }, '10.0.0.4')
  expect(b.status).toBe(409)
})

test('密码错误登录被拒（401）', async () => {
  seedInvite('INVITE-PW', { maxUses: 5 })
  await authPost('/api/auth/register', { invite: 'INVITE-PW', username: 'pwuser', password: 'secret123' }, '10.0.0.5')
  const res = await authPost('/api/auth/login', { username: 'pwuser', password: 'wrongpass' }, '10.0.0.5')
  expect(res.status).toBe(401)
})

test('邀请码用尽后第二次注册被拒（400）', async () => {
  seedInvite('INVITE-ONCE', { maxUses: 1 })
  const first = await authPost('/api/auth/register', { invite: 'INVITE-ONCE', username: 'once1', password: 'secret123' }, '10.0.0.6')
  expect(first.status).toBe(200)
  const second = await authPost('/api/auth/register', { invite: 'INVITE-ONCE', username: 'once2', password: 'secret123' }, '10.0.0.6')
  expect(second.status).toBe(400)
})

test('登录限速：同一 IP 第 6 次返回 429', async () => {
  const ip = '10.0.0.99'
  let last = await authPost('/api/auth/login', { username: 'nobody', password: 'x' }, ip)
  for (let i = 1; i < 6; i++) {
    last = await authPost('/api/auth/login', { username: 'nobody', password: 'x' }, ip)
  }
  expect(last.status).toBe(429)
})

function authGet(pathname: string, token: string) {
  return app.request(pathname, { headers: { Authorization: `Bearer ${token}` } })
}

test('refresh：有效令牌可换发新的短时令牌', async () => {
  seedUser('u-refresh', 'refresher')
  const token = await tokenFor('u-refresh', 'refresher')
  const res = await app.request('/api/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  const data = (await res.json()) as { token?: string }
  expect(typeof data.token).toBe('string')
  // 换发的令牌能正常访问
  expect((await authGet('/api/auth/me', data.token!)).status).toBe(200)
})

test('refresh：超过会话绝对上限（sst 过旧）被拒 401', async () => {
  seedUser('u-cap', 'capuser')
  // sst 设为 8 天前，超过默认 7 天上限
  const stale = await tokenFor('u-cap', 'capuser', false, { sst: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60 })
  const res = await app.request('/api/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${stale}` } })
  expect(res.status).toBe(401)
})

test('token_version 撤销：tv 与库不一致的令牌被 /api/auth/me 拒', async () => {
  seedUser('u-tv', 'tvuser')
  db.query('UPDATE users SET token_version = 3 WHERE id = ?').run('u-tv')
  const staleTv = await tokenFor('u-tv', 'tvuser', false, { tv: 2 })
  expect((await authGet('/api/auth/me', staleTv)).status).toBe(401)
  const freshTv = await tokenFor('u-tv', 'tvuser', false, { tv: 3 })
  expect((await authGet('/api/auth/me', freshTv)).status).toBe(200)
})

test('改密码自增 token_version，令旧令牌失效', async () => {
  seedUser('u-admin-pw', 'adminpw')
  db.query('UPDATE users SET is_admin = 1 WHERE id = ?').run('u-admin-pw')
  seedUser('u-victim', 'victim')
  const adminToken = await tokenFor('u-admin-pw', 'adminpw', true)
  const victimToken = await tokenFor('u-victim', 'victim', false, { tv: 0 })
  expect((await authGet('/api/auth/me', victimToken)).status).toBe(200)

  const patch = await app.request('/api/admin/users/u-victim', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password: 'brand-new-pass' }),
  })
  expect(patch.status).toBe(200)
  expect((db.query('SELECT token_version AS v FROM users WHERE id = ?').get('u-victim') as { v: number }).v).toBe(1)
  // 旧令牌（tv=0）现在失效
  expect((await authGet('/api/auth/me', victimToken)).status).toBe(401)
})

test('团队设置：管理员可设置画廊失败自动重试次数，并随用户资料下发', async () => {
  seedUser('u-admin-team-settings', 'adminteam')
  db.query('UPDATE users SET is_admin = 1 WHERE id = ?').run('u-admin-team-settings')
  seedUser('u-team-member', 'teamuser')
  const adminToken = await tokenFor('u-admin-team-settings', 'adminteam', true)
  const memberToken = await tokenFor('u-team-member', 'teamuser')

  const patch = await app.request('/api/admin/team-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ galleryAutoRetryCount: 3 }),
  })
  expect(patch.status).toBe(200)
  expect(((await patch.json()) as { galleryAutoRetryCount: number }).galleryAutoRetryCount).toBe(3)

  const invalid = await app.request('/api/admin/team-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ galleryAutoRetryCount: 6 }),
  })
  expect(invalid.status).toBe(400)

  const me = await authGet('/api/auth/me', memberToken)
  expect(me.status).toBe(200)
  expect(((await me.json()) as { galleryAutoRetryCount: number }).galleryAutoRetryCount).toBe(3)
})
