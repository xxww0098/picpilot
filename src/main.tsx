import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { AuthProvider } from './contexts/AuthProvider'
import 'streamdown/styles.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { logger, serializeError } from './lib/logger'

installMobileViewportGuards()

window.addEventListener('error', (event) => {
  logger.error('global', event.message || '未捕获的运行时错误', {
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error ? serializeError(event.error) : undefined,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  logger.error('global', '未处理的 Promise 拒绝', { reason: serializeError(event.reason) })
})

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        logger.error('sw', 'Service Worker 注册失败', { error: serializeError(error) })
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
