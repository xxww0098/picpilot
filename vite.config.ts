import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

function createLocalAuthProxy() {
  const target = process.env.LOCAL_AUTH_PROXY_URL
  if (!target) return undefined

  return {
    '/api/auth': { target, changeOrigin: true },
    '/api/admin': { target, changeOrigin: true },
    '/api/telemetry': { target, changeOrigin: true },
    '/api/gallery': { target, changeOrigin: true },
    '/api-proxy': { target, changeOrigin: true },
  }
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null
  const localAuthProxy = createLocalAuthProxy()
  const devApiProxy = devProxyConfig?.enabled
    ? {
        [devProxyConfig.prefix]: {
          target: devProxyConfig.target,
          changeOrigin: devProxyConfig.changeOrigin,
          secure: devProxyConfig.secure,
          rewrite: (path: string) =>
            path.replace(
              new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
              '',
            ),
        },
      }
    : undefined

  return {
    plugins: [react()],
    base: './',
    // server/ 是独立的 Bun 子项目，用 `bun test` 跑（其测试 import 'bun:test'），不纳入 vitest。
    test: {
      exclude: [...configDefaults.exclude, 'server/**'],
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy: localAuthProxy || devApiProxy ? { ...localAuthProxy, ...devApiProxy } : undefined,
    },
    preview: {
      host: true,
      proxy: localAuthProxy,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('react-dom') || /\/react\//.test(id)) return 'vendor-react'
            if (
              id.includes('streamdown') ||
              id.includes('mermaid') ||
              id.includes('shiki') ||
              id.includes('@shikijs')
            ) {
              return 'vendor-markdown'
            }
            if (id.includes('fflate')) return 'vendor-fflate'
            if (id.includes('/zod/')) return 'vendor-zod'
            if (id.includes('zustand')) return 'vendor-zustand'
          },
        },
      },
    },
  }
})
