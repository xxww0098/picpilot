import { lazy, Suspense, useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/config/urlSettings'
import { mergeImportedSettings } from './lib/shared/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/config/customProviderConfigUrl'
import { logger, serializeError } from './lib/shared/logger'
import { useAuth } from './contexts/AuthProvider'
import Header from './components/workspaces/Header'
import SearchBar from './components/workspaces/SearchBar'
import TaskGrid from './components/workspaces/TaskGrid'
import QueueBanner from './components/workspaces/QueueBanner'
import InputBar from './components/workspaces/InputBar'
import DetailModal from './components/modals/DetailModal'
import Lightbox from './components/modals/Lightbox'
import ConfirmDialog from './components/ui/ConfirmDialog'
import PromptDialog from './components/ui/PromptDialog'
import Toast from './components/ui/Toast'
import ImageContextMenu from './components/workspaces/ImageContextMenu'
import LoginModal from './components/modals/LoginModal'
import RegisterModal from './components/modals/RegisterModal'
import { useGlobalClickSuppression } from './lib/ui/clickSuppression'

const AgentWorkspace = lazy(() => import('./components/workspaces/AgentWorkspace'))
const VideoWorkspace = lazy(() => import('./components/workspaces/VideoWorkspace'))
const WorkflowCanvas = lazy(() => import('./components/workflow/WorkflowCanvas'))
const SettingsModal = lazy(() => import('./components/modals/SettingsModal'))
const LogPanel = lazy(() => import('./components/modals/LogPanel'))
// 遮罩编辑器较重（canvas + 图像处理），首屏不需要：首次打开时再加载，加载后保持挂载（行为同此前的常驻挂载）。
const MaskEditorModal = lazy(() => import('./components/modals/MaskEditorModal'))

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
  const maskEditorImageId = useStore((s) => s.maskEditorImageId)
  // 一旦打开过遮罩编辑器就保持挂载（与原先常驻挂载行为一致），仅把首次加载推迟到首次打开。
  const [maskEditorMounted, setMaskEditorMounted] = useState(false)
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
          logger.warn('system', '自定义 Provider 配置 URL 导入失败', { error: serializeError(error) })
        })
    }

    initStore()
  }, [status, setSettings])

  useEffect(() => {
    if (maskEditorImageId && !maskEditorMounted) setMaskEditorMounted(true)
  }, [maskEditorImageId, maskEditorMounted])

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
      {appMode === 'workflow' ? (
        <Suspense
          fallback={
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              加载工作流画布…
            </div>
          }
        >
          <WorkflowCanvas />
        </Suspense>
      ) : appMode === 'agent' ? (
        <Suspense
          fallback={
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              加载 Agent 工作区…
            </div>
          }
        >
          <AgentWorkspace />
        </Suspense>
      ) : appMode === 'video' ? (
        <Suspense
          fallback={
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              加载视频工作区…
            </div>
          }
        >
          <VideoWorkspace />
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
      {appMode !== 'workflow' && <InputBar />}
      <DetailModal />
      <Lightbox />
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      <ConfirmDialog />
      <PromptDialog />
      {showLogPanel && (
        <Suspense fallback={null}>
          <LogPanel />
        </Suspense>
      )}
      <Toast />
      {maskEditorMounted && (
        <Suspense fallback={null}>
          <MaskEditorModal />
        </Suspense>
      )}
      <ImageContextMenu />
    </>
  )
}
