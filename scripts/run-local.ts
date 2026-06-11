import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

type CommandResult = ReturnType<typeof spawnSync>

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const logger = {
  info: (msg: string) => console.log(`[local-runner] ${msg}`),
  warn: (msg: string) => console.warn(`[local-runner] WARN ${msg}`),
  error: (msg: string) => console.error(`[local-runner] ERROR ${msg}`),
}

function ensureSuccess(result: CommandResult, label: string): void {
  if (result.error) {
    throw new Error(`${label} 启动失败：${result.error.message}`)
  }
  if (result.status && result.status !== 0) {
    process.exit(result.status)
  }
}

function readCommandOutput(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  return result.stdout.trim()
}

function run(command: string, args: string[], label: string, cwd = process.cwd()): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd })
  ensureSuccess(result, label)
}

const nodeVersion = readCommandOutput('node', ['-v'])
if (!nodeVersion) {
  logger.error('Node.js is not installed')
  process.exit(1)
}

const npmVersion = readCommandOutput(npmCommand, ['-v'])
if (!npmVersion) {
  logger.error('npm is not installed')
  process.exit(1)
}

const goVersion = readCommandOutput('go', ['version'])
if (!goVersion) {
  logger.error('Go is not installed (the backend is Go, see server-go/)')
  process.exit(1)
}

logger.info(`Starting local picpilot (node ${nodeVersion}, npm ${npmVersion}, ${goVersion})`)

logger.info('[1/3] Installing dependencies')
run(npmCommand, ['install'], 'npm install')

logger.info('[2/3] Building frontend')
run(npmCommand, ['run', 'build'], 'npm run build')

const authPort = process.env.AUTH_PORT ?? '3001'
const repoRoot = process.cwd()
const localEnv = {
  ...process.env,
  AUTH_PORT: authPort,
  JWT_SECRET: process.env.JWT_SECRET ?? 'local-dev-jwt-secret-change-before-deploy',
  ADMIN_USERS: process.env.ADMIN_USERS ?? 'admin:admin',
  STATIC_DIR: process.env.STATIC_DIR ?? join(repoRoot, 'dist'),
  DATA_DIR: process.env.DATA_DIR ?? join(repoRoot, 'data'),
}

logger.info(`[3/3] Starting Go server at http://localhost:${authPort}`)
if (!process.env.ADMIN_USERS) logger.warn('Using default local admin: admin/admin')
const result = spawnSync('go', ['run', '.'], { stdio: 'inherit', cwd: 'server-go', env: localEnv })
ensureSuccess(result, 'go run server-go')
