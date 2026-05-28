import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import { fetchCurrentUser } from './lib/auth'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import LogPanel from './components/LogPanel'
import LoginModal from './components/LoginModal'
import RegisterModal from './components/RegisterModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

let customProviderConfigUrlImportStarted = false

type AuthState = 'loading' | 'login' | 'register' | 'ready'

function readInviteFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  const invite = params.get('invite')
  const path = window.location.pathname
  // /register?invite=xxx 或 ?invite=xxx 都触发注册
  if (invite || path === '/register' || path.endsWith('/register')) return invite ?? ''
  return null
}

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const [authState, setAuthState] = useState<AuthState>('loading')
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    fetchCurrentUser().then((user) => {
      if (user === null) {
        setAuthState(readInviteFromUrl() !== null ? 'register' : 'login')
      } else {
        setAuthState('ready')
      }
    })
  }, [])

  useEffect(() => {
    if (authState !== 'ready') return

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
  }, [authState, setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  if (authState === 'loading') return null

  if (authState === 'login') {
    // Reload so store and IndexedDB re-init under the new userId namespace.
    return <LoginModal onSuccess={() => window.location.reload()} onSwitchToRegister={() => setAuthState('register')} />
  }

  if (authState === 'register') {
    return (
      <RegisterModal
        initialInvite={readInviteFromUrl() ?? ''}
        onSuccess={() => window.location.reload()}
        onSwitchToLogin={() => setAuthState('login')}
      />
    )
  }

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <LogPanel />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
