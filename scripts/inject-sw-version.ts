import { readFileSync, writeFileSync } from 'node:fs'

// 把 package.json 的 version 注入编译产物 dist/sw.js 的缓存名占位符（见 src/sw.ts 首行），
// 替代「发布时手动同步 CACHE_NAME」的旧约定。由 build:sw 在 tsc 编译后调用。
const PLACEHOLDER = '__APP_VERSION__'
const SW_PATH = 'dist/sw.js'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
if (!version) {
  throw new Error('package.json 缺少 version 字段')
}

const compiled = readFileSync(SW_PATH, 'utf8')
if (!compiled.includes(PLACEHOLDER)) {
  throw new Error(`${SW_PATH} 中未找到占位符 ${PLACEHOLDER}（src/sw.ts 的 CACHE_NAME 是否被改动？）`)
}

writeFileSync(SW_PATH, compiled.split(PLACEHOLDER).join(version))
console.log(`[inject-sw-version] ${SW_PATH} -> picpilot-v${version}`)
