import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, getGalleryDisplayedImageIds } from '../store'
import { getActiveApiProfile, normalizeSettings, switchApiProfileProvider } from '../lib/apiProfiles'
import { IMAGE_MODELS } from '../lib/imageModels'
import { CHAT_MODELS } from '../lib/chatModels'
import ModelPicker from './ModelPicker'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { useTooltip } from '../hooks/useTooltip'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import ViewportTooltip from './ViewportTooltip'
import HistoryModal from './HistoryModal'
import { BellIcon, ChevronDownIcon, DownloadIcon, EditIcon, HelpCircleIcon, HistoryIcon, MoreIcon, PhotoIcon, SettingsIcon, TerminalIcon, WrenchIcon } from './icons'
import { useAuth } from '../contexts/AuthProvider'
import { useNotificationUnread } from '../hooks/useNotificationUnread'
import { openConfirmDialog, showAppToast } from '../lib/dialog'
import { getUserFacingErrorMessage } from '../lib/userFacingText'
import { downloadImagesAsZip, formatExportFileTime } from '../lib/downloadImages'
import type { AppMode } from '../types'
import { useIsMobile } from '../hooks/useIsMobile'
import UserMenu from './UserMenu'

const HelpModal = lazy(() => import('./HelpModal'))
const GalleryView = lazy(() => import('./GalleryView'))
const AdminPanel = lazy(() => import('./admin/AdminPanel'))
const NotificationsPanel = lazy(() => import('./NotificationsPanel'))

export default function Header() {
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowLogPanel = useStore((s) => s.setShowLogPanel)
  const agentMobileHeaderVisible = useStore((s) => s.agentMobileHeaderVisible)
  const agentConversations = useStore((s) => s.agentConversations)
  const activeAgentConversationId = useStore((s) => s.activeAgentConversationId)
  const activeConversation = agentConversations.find((item) => item.id === activeAgentConversationId)
  const isMobile = useIsMobile()
  const { hasUpdate, latestRelease, dismiss } = useVersionCheck()
  const [showHelp, setShowHelp] = useState(false)
  const [downloadingGallery, setDownloadingGallery] = useState(false)
  const [hintVisible, setHintVisible] = useState(false)
  const [scrollDirection, setScrollDirection] = useState<'up' | 'down'>('up')
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const createConversation = useStore((s) => s.createAgentConversation)

  // 图像模型切换开关：仅画廊模式 + 内置 OpenAI 兼容 + Images 接口时出现
  // （Agent 走对话模型、自定义服务商/Responses 在设置里管理模型，故不显示）。
  // 切换写入活动配置的 model 字段（setSettings 的 legacy 覆盖路径，等价于设置里的模型输入框）。
  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  // 画廊模式：图像模型开关（仅内置 OpenAI Images 配置时）。
  const showImagePicker = appMode === 'gallery'
    && (activeProfile.provider === 'openai' || activeProfile.provider === 'xAI')
    && activeProfile.apiMode === 'images'
  // Agent 模式：对话模型开关（始终可切换）。
  const showChatPicker = appMode === 'agent'
  // 顶栏模型开关占一行/一段，移动端占位高度需相应调整。
  const showAnyPicker = showImagePicker || showChatPicker
  const mobileAgentHeaderHidden = isMobile && appMode === 'agent' && !agentMobileHeaderVisible
  const handleModelChange = useCallback((model: string) => {
    const option = IMAGE_MODELS.find((item) => item.id === model)
    const provider = option?.provider === 'xAI' ? 'xAI' : 'openai'
    const normalized = normalizeSettings(settings)
    const currentProfile = normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) ?? activeProfile
    const switchedProfile = currentProfile.provider === provider
      ? currentProfile
      : switchApiProfileProvider(currentProfile, provider)
    const nextProfile = {
      ...switchedProfile,
      provider,
      model,
      apiMode: 'images' as const,
    }
    setSettings({
      ...normalized,
      model,
      apiMode: 'images',
      activeProfileId: currentProfile.id,
      profiles: normalized.profiles.map((profile) => profile.id === currentProfile.id ? nextProfile : profile),
    })
  }, [activeProfile, settings, setSettings])
  const handleAgentModelChange = useCallback((agentModel: string) => {
    setSettings({ agentModel })
  }, [setSettings])

  useEffect(() => {
    if (appMode === 'agent') {
      setScrollDirection('up')
      return
    }

    let lastScrollY = window.scrollY
    let ticking = false

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentScrollY = window.scrollY
          if (currentScrollY < 20) {
            setScrollDirection('up')
          } else if (currentScrollY > lastScrollY + 10) {
            setScrollDirection('down')
          } else if (currentScrollY < lastScrollY - 10) {
            setScrollDirection('up')
          }
          lastScrollY = currentScrollY
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [appMode])

  useEffect(() => {
    if (appMode === 'agent' && !agentMobileHeaderVisible) {
      setHintVisible(true)
      const timer = setTimeout(() => {
        setHintVisible(false)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [appMode, agentMobileHeaderVisible])

  const settingsTooltip = useTooltip()
  const notificationsTooltip = useTooltip()
  const { user } = useAuth()
  const [showGallery, setShowGallery] = useState(false)
  const [galleryUserId, setGalleryUserId] = useState<string | null>(null)
  const [showAdmin, setShowAdmin] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const { unread: unreadNotifications, setUnread: setUnreadNotifications, refresh: refreshUnreadNotifications } = useNotificationUnread(Boolean(user))

  const handleDownloadGallery = async () => {
    if (downloadingGallery) return
    // 下载「用户自己的画廊（历史）」当前显示的图片，而非公开/共享画廊
    const ids = getGalleryDisplayedImageIds(useStore.getState())
    if (ids.length === 0) {
      showAppToast('画廊里还没有可下载的图片。', 'info')
      return
    }
    openConfirmDialog({
      title: '下载画廊图片',
      message: `将把当前画廊显示的 ${ids.length} 张图片打包成一个 ZIP 文件下载，确定吗？`,
      confirmText: '下载',
      onConfirm: async () => {
        setDownloadingGallery(true)
        showAppToast(`正在打包 ${ids.length} 张图片，请稍候…`, 'info')
        try {
          const { successCount, failCount } = await downloadImagesAsZip(
            ids,
            `picpilot-gallery_${formatExportFileTime(new Date())}`,
          )
          if (successCount === 0) {
            showAppToast('全部图片下载失败，请稍后重试。', 'error')
          } else if (failCount > 0) {
            showAppToast(`已打包 ${successCount} 张，${failCount} 张获取失败。`, 'error')
          } else {
            showAppToast(`已打包下载 ${successCount} 张图片。`, 'success')
          }
        } catch (e) {
          showAppToast(getUserFacingErrorMessage(e, '打包下载失败'), 'error')
        } finally {
          setDownloadingGallery(false)
        }
      },
    })
  }

  return (
    <>
      <header
        data-no-drag-select
        aria-hidden={mobileAgentHeaderHidden ? true : undefined}
        inert={mobileAgentHeaderHidden ? true : undefined}
        className={`safe-area-top fixed top-0 left-0 right-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08] transition-transform duration-300 ease-in-out ${appMode === 'agent' && !agentMobileHeaderVisible ? '-translate-y-full sm:translate-y-0' : 'translate-y-0'}`}
      >
        <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between relative">
          <div className="flex-1 min-w-0 pr-2 flex items-center gap-2">
            <h1 className="inline-flex items-center gap-2 relative mr-2">
              <img
                src="./pwa-icon-192.png"
                alt=""
                width={28}
                height={28}
                className="h-7 w-7 shrink-0 rounded-lg ring-1 ring-black/5 dark:ring-white/10"
                aria-hidden
              />
              <span className="text-[17px] sm:text-lg font-bold tracking-tight text-gray-800 dark:text-gray-100">
                PicPilot
              </span>
              {hasUpdate && latestRelease && (
                <a
                  href={latestRelease.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={dismiss}
                  className="absolute -right-1 -top-1 translate-x-full -translate-y-1/4 px-1 py-0.5 rounded-[4px] border border-red-500/30 text-[9px] font-black bg-red-500 text-white hover:bg-red-600 transition-all animate-fade-in leading-none shadow-sm"
                  title={`新版本 ${latestRelease.tag}`}
                >
                  NEW
                </a>
              )}
            </h1>
            {appMode === 'agent' && <div className="hidden sm:flex lg:hidden items-center gap-1 relative">
              <button
                ref={historyButtonRef}
                type="button"
                onClick={() => setShowHistoryModal((visible) => !visible)}
                className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-lg transition-colors"
                title="历史记录"
              >
                <HistoryIcon className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppMode('agent')
                  createConversation()
                }}
                className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-lg transition-colors"
                title="新对话"
              >
                <EditIcon className="w-5 h-5" />
              </button>
              {showHistoryModal && (
                <HistoryModal onClose={() => setShowHistoryModal(false)} ignoreOutsideClickRef={historyButtonRef} />
              )}
            </div>}
          </div>
          {appMode === 'agent' && activeConversation && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden sm:flex lg:hidden max-w-[30%]">
              <button
                type="button"
                onClick={() => {
                  setShowHistoryModal(true)
                  // Use setTimeout to ensure HistoryModal is mounted before setting editing id
                  setTimeout(() => {
                    useStore.getState().setAgentEditingConversationId(activeConversation.id)
                  }, 0)
                }}
                className="text-sm font-semibold text-gray-700 dark:text-gray-300 truncate hover:bg-gray-100 dark:hover:bg-white/[0.04] px-2 py-1 rounded transition-colors"
              >
                {activeConversation.title || 'Agent'}
              </button>
            </div>
          )}
          {showImagePicker && (
            <div className="hidden sm:flex items-center mr-2">
              <ModelPicker model={activeProfile.model} options={IMAGE_MODELS} onChange={handleModelChange} ariaLabel="图像模型" />
            </div>
          )}
          {showChatPicker && (
            <div className="hidden sm:flex items-center mr-2">
              <ModelPicker model={settings.agentModel} options={CHAT_MODELS} onChange={handleAgentModelChange} ariaLabel="对话模型" />
            </div>
          )}
          <div className="hidden sm:flex items-center gap-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100/70 dark:bg-white/[0.04] p-1 mr-4">
            <button
              type="button"
              onClick={() => setAppMode('gallery')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'gallery' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              画廊
            </button>
            <button
              type="button"
              onClick={() => setAppMode('agent')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'agent' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              对话
            </button>
            <button
              type="button"
              onClick={() => setAppMode('video')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'video' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              视频
            </button>
            <button
              type="button"
              onClick={() => setAppMode('workflow')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'workflow' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              工作流
            </button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {user && (
              <div className="relative" {...notificationsTooltip.handlers}>
                <button
                  onClick={() => { dismissAllTooltips(); setShowNotifications(true) }}
                  className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                  aria-label={unreadNotifications > 0 ? `通知（${unreadNotifications} 条未读）` : '通知'}
                >
                  <BellIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                  {unreadNotifications > 0 && (
                    <span className="absolute top-1 right-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white tabular-nums ring-2 ring-white dark:ring-gray-950">
                      {unreadNotifications > 99 ? '99+' : unreadNotifications}
                    </span>
                  )}
                </button>
                <ViewportTooltip visible={notificationsTooltip.visible} className="whitespace-nowrap">通知</ViewportTooltip>
              </div>
            )}
            <HeaderMoreMenu
              hasUser={Boolean(user)}
              isAdmin={Boolean(user?.isAdmin)}
              downloadingGallery={downloadingGallery}
              onOpenSharedGallery={() => { setGalleryUserId(null); setShowGallery(true) }}
              onDownloadGallery={() => void handleDownloadGallery()}
              onHelp={() => setShowHelp(true)}
              onLogs={() => setShowLogPanel(true)}
              onAdmin={() => setShowAdmin(true)}
            />
            <div
              className="relative"
              {...settingsTooltip.handlers}
            >
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                aria-label="设置"
              >
                <SettingsIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              </button>
              <ViewportTooltip visible={settingsTooltip.visible} className="whitespace-nowrap">
                设置
              </ViewportTooltip>
            </div>
            {user && (
              <UserMenu
                user={user}
                onOpenGallery={() => {
                  setGalleryUserId(user.userId)
                  setShowGallery(true)
                }}
              />
            )}
          </div>
        </div>
          <div className={`safe-area-x sm:hidden overflow-hidden transition-all duration-300 ease-in-out ${appMode !== 'agent' && scrollDirection === 'down' ? 'max-h-0 opacity-0 pb-0' : 'max-h-28 opacity-100 pb-2'}`}>
          <div className="mx-2 flex items-center gap-2">
            <MobileViewSelect mode={appMode} onChange={setAppMode} />
            {showImagePicker && (
              <MobileModelSelect model={activeProfile.model} options={IMAGE_MODELS} onChange={handleModelChange} ariaLabel="图像模型" />
            )}
            {showChatPicker && (
              <MobileModelSelect model={settings.agentModel} options={CHAT_MODELS} onChange={handleAgentModelChange} ariaLabel="对话模型" />
            )}
          </div>
        </div>
      </header>
      
      {/* Hint for sliding down */}
      <div
        aria-hidden={appMode === 'agent' && hintVisible && !agentMobileHeaderVisible ? undefined : true}
        className={`fixed top-0 left-0 right-0 z-30 flex justify-center pointer-events-none transition-all duration-300 ease-in-out sm:hidden ${appMode === 'agent' && hintVisible && !agentMobileHeaderVisible ? 'translate-y-[env(safe-area-inset-top,0px)] opacity-100' : '-translate-y-full opacity-0'}`}
      >
        <div className="bg-black/60 backdrop-blur-sm text-white text-xs px-3 py-1.5 rounded-b-xl shadow-lg">
          列表顶部下拉展示顶栏
        </div>
      </div>

      <div className={`safe-area-top invisible pointer-events-none transition-all duration-300 ease-in-out ${appMode === 'agent' && !agentMobileHeaderVisible ? 'max-h-0 sm:max-h-[500px] opacity-0 sm:opacity-100 overflow-hidden sm:overflow-visible' : 'max-h-[500px] opacity-100'}`} aria-hidden="true">
        <div className="safe-header-inner" />
        <div className={`safe-area-x sm:hidden overflow-hidden transition-all duration-300 ease-in-out ${appMode !== 'agent' && scrollDirection === 'down' ? 'max-h-0 pb-0' : 'max-h-28 pb-2'}`}>
          <div className="mx-2 flex items-center gap-2">
            <div className="min-w-0 flex-1 rounded-xl border border-transparent px-3 py-1.5 text-sm">占位</div>
            {showAnyPicker && (
              <div className="min-w-0 flex-1 rounded-xl border border-transparent px-3 py-1.5 text-sm">占位</div>
            )}
          </div>
        </div>
      </div>
      {showHelp && (
        <Suspense fallback={null}>
          <HelpModal appMode={appMode} onClose={() => setShowHelp(false)} />
        </Suspense>
      )}
      {showGallery && (
        <Suspense fallback={null}>
          <GalleryView
            open={showGallery}
            onClose={() => setShowGallery(false)}
            userId={galleryUserId ?? undefined}
            title={galleryUserId ? '我的共享画廊' : '共享画廊'}
          />
        </Suspense>
      )}
      {showAdmin && (
        <Suspense fallback={null}>
          <AdminPanel open={showAdmin} onClose={() => setShowAdmin(false)} />
        </Suspense>
      )}
      {showNotifications && (
        <Suspense fallback={null}>
          <NotificationsPanel
            open={showNotifications}
            onClose={() => {
              setShowNotifications(false)
              void refreshUnreadNotifications()
            }}
            onUnreadChange={setUnreadNotifications}
          />
        </Suspense>
      )}
    </>
  )
}

const MOBILE_VIEW_OPTIONS: { value: AppMode; label: string }[] = [
  { value: 'gallery', label: '画廊' },
  { value: 'agent', label: '对话' },
  { value: 'video', label: '视频' },
  { value: 'workflow', label: '工作流' },
]

function MobileViewSelect({
  mode,
  onChange,
}: {
  mode: AppMode
  onChange: (mode: AppMode) => void
}) {
  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">视图</span>
      <select
        value={mode}
        onChange={(event) => onChange(event.target.value as AppMode)}
        aria-label="视图"
        className="h-[2.375rem] w-full appearance-none truncate rounded-xl border border-gray-200 bg-white px-3 pr-7 text-sm font-medium text-gray-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
      >
        {MOBILE_VIEW_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
    </label>
  )
}

function MobileModelSelect({
  model,
  options,
  onChange,
  ariaLabel,
}: {
  model: string
  options: { id: string; label: string; provider: string }[]
  onChange: (model: string) => void
  ariaLabel: string
}) {
  const allOptions = options.some((option) => option.id === model)
    ? options
    : [...options, { id: model, label: model, provider: '自定义' }]

  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">{ariaLabel}</span>
      <select
        value={model}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        className="h-[2.375rem] w-full appearance-none truncate rounded-xl border border-gray-200 bg-white px-3 pr-7 text-xs font-medium text-gray-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
      >
        {allOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
    </label>
  )
}

// 「更多」溢出菜单：把不常用的工具（共享画廊、下载、操作指南、运行日志、管理面板）收进下拉，
// 让顶栏只保留通知 / 设置 / 账户，减少图标拥挤。
function HeaderMoreMenu({
  hasUser,
  isAdmin,
  downloadingGallery,
  onOpenSharedGallery,
  onDownloadGallery,
  onHelp,
  onLogs,
  onAdmin,
}: {
  hasUser: boolean
  isAdmin: boolean
  downloadingGallery: boolean
  onOpenSharedGallery: () => void
  onDownloadGallery: () => void
  onHelp: () => void
  onLogs: () => void
  onAdmin: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  function run(action: () => void) {
    setOpen(false)
    dismissAllTooltips()
    action()
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => { dismissAllTooltips(); setOpen((v) => !v) }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多"
        className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
      >
        <MoreIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[11rem] overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg shadow-black/10 ring-1 ring-black/5 dark:border-white/10 dark:bg-gray-900 dark:shadow-black/40 dark:ring-white/10"
        >
          {hasUser && (
            <HeaderMenuItem icon={<PhotoIcon className="h-4 w-4" />} onClick={() => run(onOpenSharedGallery)}>
              共享画廊
            </HeaderMenuItem>
          )}
          {hasUser && (
            <HeaderMenuItem
              icon={
                downloadingGallery ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <DownloadIcon className="h-4 w-4" />
                )
              }
              disabled={downloadingGallery}
              onClick={() => run(onDownloadGallery)}
            >
              下载画廊图片
            </HeaderMenuItem>
          )}
          <HeaderMenuItem icon={<HelpCircleIcon className="h-4 w-4" />} onClick={() => run(onHelp)}>
            操作指南
          </HeaderMenuItem>
          <HeaderMenuItem icon={<TerminalIcon className="h-4 w-4" />} onClick={() => run(onLogs)}>
            运行日志
          </HeaderMenuItem>
          {isAdmin && (
            <HeaderMenuItem icon={<WrenchIcon className="h-4 w-4" />} onClick={() => run(onAdmin)}>
              管理面板
            </HeaderMenuItem>
          )}
        </div>
      )}
    </div>
  )
}

function HeaderMenuItem({
  children,
  icon,
  onClick,
  disabled = false,
}: {
  children: ReactNode
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-white/[0.06]"
    >
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}
