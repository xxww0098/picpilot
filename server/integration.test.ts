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

async function tokenFor(userId: string, username: string, isAdmin = false): Promise<string> {
  return sign({ sub: userId, username, isAdmin, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
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
