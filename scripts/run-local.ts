import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import pino from 'pino'

type CommandResult = ReturnType<typeof spawnSync>

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const PRODUCT = 'picpilot'
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: PRODUCT, component: 'local-runner' },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname,app,component',
      messageFormat: '[{component}] {msg}',
    },
  },
})

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
  logger.error({ scope: 'runtime' }, 'Node.js is not installed')
  process.exit(1)
}

const npmVersion = readCommandOutput(npmCommand, ['-v'])
if (!npmVersion) {
  logger.error({ scope: 'runtime' }, 'npm is not installed')
  process.exit(1)
}

const goVersion = readCommandOutput('go', ['version'])
if (!goVersion) {
  logger.error({ scope: 'runtime' }, 'Go is not installed (the backend is Go, see server-go/)')
  process.exit(1)
}

logger.info({ mode: 'local-go', npm: npmVersion, node: nodeVersion, go: goVersion }, 'Starting local picpilot')

logger.info({ step: '1/3' }, 'Installing dependencies')
run(npmCommand, ['install'], 'npm install')

logger.info({ step: '2/3' }, 'Building frontend')
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

logger.info({ step: '3/3', url: `http://localhost:${authPort}` }, 'Starting Go server')
if (!process.env.ADMIN_USERS) logger.warn({ username: 'admin', password: 'admin' }, 'Using default local admin')
const result = spawnSync('go', ['run', '.'], { stdio: 'inherit', cwd: 'server-go', env: localEnv })
ensureSuccess(result, 'go run server-go')
