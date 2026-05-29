import { lazy, Suspense, useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useAuth } from './contexts/AuthProvider'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import QueueBanner from './components/QueueBanner'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import ConfirmDialog from './components/ConfirmDialog'
import PromptDialog from './components/PromptDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import LoginModal from './components/LoginModal'
import RegisterModal from './components/RegisterModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

const AgentWorkspace = lazy(() => import('./components/AgentWorkspace'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const LogPanel = lazy(() => import('./components/LogPanel'))

let customProviderConfigUrlImportStarted = false

type AuthView = 'login' | 'register'

function isRegisterPath(pathname: string) {
  return pathname === '/register' || pathname.endsWith('/register')
}

/** 仅 /register?invite=xxx 形式才进入注册界面 */
function readInviteFromUrl(): string | null {
  const path = window.location.pathname
  if (!isRegisterPath(path)) return null
  const invite = new URLSearchParams(window.location.search).get('invite')?.trim()
  return invite || null
}

function clearRegisterFromUrl() {
  const url = new URL(window.location.href)
  url.searchParams.delete('invite')
  const nextPath = url.pathname.replace(/\/register\/?$/, '') || '/'
  window.history.replaceState(null, '', `${nextPath}${url.search}${url.hash}`)
}

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const showSettings = useStore((s) => s.showSettings)
  const showLogPanel = useStore((s) => s.showLogPanel)
  const { status } = useAuth()
  const [authView, setAuthView] = useState<AuthView>(() => (readInviteFromUrl() !== null ? 'register' : 'login'))
  useGlobalClickSuppression()

  useEffect(() => {
    if (status !== 'unauthenticated') return
    if (readInviteFromUrl() !== null) return
    if (!isRegisterPath(window.location.pathname)) return
    clearRegisterFromUrl()
    setAuthView('login')
  }, [status])

  useEffect(() => {
    if (status !== 'authenticated' && status !== 'disabled') return

    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    const customProviderConfigUrl = getCustomProviderConfigUrl()
    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }

    initStore()
  }, [status, setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  if (status === 'loading') return null

  if (status === 'unauthenticated') {
    if (authView === 'register') {
      return (
        <RegisterModal
          initialInvite={readInviteFromUrl() ?? ''}
          onSuccess={() => window.location.reload()}
          onSwitchToLogin={() => {
            clearRegisterFromUrl()
            setAuthView('login')
          }}
        />
      )
    }

    return (
      <LoginModal
        onSuccess={() => window.location.reload()}
        onSwitchToRegister={() => setAuthView('register')}
      />
    )
  }

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <Suspense
          fallback={
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              加载 Agent 工作区…
            </div>
          }
        >
          <AgentWorkspace />
        </Suspense>
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <QueueBanner />
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      <ConfirmDialog />
      <PromptDialog />
      <SupportPromptModal />
      {showLogPanel && (
        <Suspense fallback={null}>
          <LogPanel />
        </Suspense>
      )}
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
