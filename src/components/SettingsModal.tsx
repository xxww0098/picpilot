import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useStore, importData, clearData, type SettingsTab } from '../store'
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_XAI_IMAGES_MODEL,
  getApiProviderLabel,
  getActiveApiProfile,
  getDefaultModelForProvider,
  importCustomProviderSettingsFromJson,
  isOpenAICompatibleProvider,
  mergeImportedSettings,
  normalizeAgentMaxToolRounds,
  normalizeCustomProviderDefinition,
  normalizeSettings,
  normalizeStreamPartialImages,
  normalizeVideoDurationSeconds,
  switchApiProfileProvider,
} from '../lib/apiProfiles'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { testApiConnection } from '../lib/apiConnectionTest'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type CustomProviderDefinition } from '../types'
import { DEFAULT_DROPDOWN_MAX_HEIGHT, getDropdownMaxHeight } from '../lib/dropdown'
import { getUserFacingErrorMessage } from '../lib/userFacingText'
import ModalShell from './ModalShell'
import Select from './Select'
import ViewportTooltip from './ViewportTooltip'
import { ChevronDownIcon, CloseIcon, CopyIcon, PlusIcon, TrashIcon, DragHandleIcon, LinkIcon } from './icons'
import {
  ADD_CUSTOM_PROVIDER_VALUE,
  CUSTOM_PROVIDER_LLM_PROMPT,
  createDefaultCustomProviderForm,
  customProviderFormToInput,
  customProviderToForm,
  getImportedProfileFromMergedSettings,
  isPristineNewOpenAIProfile,
  newId,
  type CustomProviderForm,
} from './settingsModal/constants'
import SettingsGeneralSection from './settingsModal/SettingsGeneralSection'
import SettingsAgentSection from './settingsModal/SettingsAgentSection'
import SettingsAboutSection from './settingsModal/SettingsAboutSection'
import SettingsDataSection from './settingsModal/SettingsDataSection'
import SettingsCustomProviderModal from './settingsModal/SettingsCustomProviderModal'

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const settingsTabRequest = useStore((s) => s.settingsTabRequest)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const reusedTaskApiProfileId = useStore((s) => s.reusedTaskApiProfileId)
  const setReusedTaskApiProfile = useStore((s) => s.setReusedTaskApiProfile)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const importInputRef = useRef<HTMLInputElement>(null)
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const profileMenuTriggerRef = useRef<HTMLButtonElement>(null)

  const profileImportUrlTooltipTimerRef = useRef<number | null>(null)
  const duplicateProfileTooltipTimerRef = useRef<number | null>(null)
  const llmPromptTooltipTimerRef = useRef<number | null>(null)
  const settingsScrollBoundaryRef = useRef<HTMLDivElement>(null)
  const customProviderScrollBoundaryRef = useRef<HTMLDivElement>(null)
  
  const [draft, setDraft] = useState<AppSettings>(normalizeSettings(settings))
  const [timeoutInput, setTimeoutInput] = useState(String(getActiveApiProfile(settings).timeout))
  const [agentMaxToolRoundsInput, setAgentMaxToolRoundsInput] = useState(String(settings.agentMaxToolRounds))
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [profileMenuMaxHeight, setProfileMenuMaxHeight] = useState(DEFAULT_DROPDOWN_MAX_HEIGHT)
  const [showCustomProviderImport, setShowCustomProviderImport] = useState(false)
  const [editingCustomProviderId, setEditingCustomProviderId] = useState<string | null>(null)
  const [customProviderForm, setCustomProviderForm] = useState<CustomProviderForm>(createDefaultCustomProviderForm())
  const [customProviderImportError, setCustomProviderImportError] = useState<string | null>(null)
  const [profileImportUrlTooltipVisible, setProfileImportUrlTooltipVisible] = useState(false)
  const [duplicateProfileTooltipVisible, setDuplicateProfileTooltipVisible] = useState(false)
  const [llmPromptTooltipVisible, setLlmPromptTooltipVisible] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('api')
  const [exportConfig, setExportConfig] = useState(true)
  const [exportTasks, setExportTasks] = useState(true)
  const [importConfig, setImportConfig] = useState(true)
  const [importTasks, setImportTasks] = useState(true)
  const [clearConfig, setClearConfig] = useState(true)
  const [clearTasks, setClearTasks] = useState(true)
  const [isImportingData, setIsImportingData] = useState(false)
  const [isImportingJson, setIsImportingJson] = useState(false)
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null)
  const [dragOverProfileId, setDragOverProfileId] = useState<string | null>(null)
  const [dragDropPosition, setDragDropPosition] = useState<'before' | 'after' | null>(null)
  const [profileTouchDragPreview, setProfileTouchDragPreview] = useState<{
    label: string
    providerLabel: string
    x: number
    y: number
    width: number
    height: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const profileTouchDragRef = useRef<{ id: string, startX: number, startY: number, moved: boolean } | null>(null)
  const [testingConnectionProfileId, setTestingConnectionProfileId] = useState<string | null>(null)
  const [showAdvancedApi, setShowAdvancedApi] = useState(false)

  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId) ?? draft.profiles[0] ?? getActiveApiProfile(draft)
  const activeProviderIsOpenAICompatible = isOpenAICompatibleProvider(draft, activeProfile.provider)
  const activeCustomProvider = draft.customProviders.find((provider) => provider.id === activeProfile.provider)
  const defaultProviderOrder = ['openai', 'xAI', ...draft.customProviders.map(p => p.id)]
  const providerOrder = draft.providerOrder || defaultProviderOrder

  const unorderedProviderOptions = [
    { label: 'OpenAI 兼容接口', value: 'openai', draggable: true },
    { label: 'xAI Imagine', value: 'xAI', draggable: true },
    ...draft.customProviders.map((provider) => ({
      label: provider.name,
      value: provider.id,
      draggable: true,
      actions: [
        { label: '编辑', onClick: () => openEditCustomProvider(provider) },
        {
          label: '删除',
          variant: 'danger' as const,
          onClick: () => confirmDeleteCustomProvider(provider),
        },
      ],
    })),
  ]

  const providerOptions = [
    { label: '创建自定义服务商', value: ADD_CUSTOM_PROVIDER_VALUE, variant: 'action' as const },
    ...unorderedProviderOptions.sort((a, b) => {
      const aIndex = providerOrder.indexOf(String(a.value))
      const bIndex = providerOrder.indexOf(String(b.value))
      const validA = aIndex !== -1 ? aIndex : defaultProviderOrder.indexOf(String(a.value))
      const validB = bIndex !== -1 ? bIndex : defaultProviderOrder.indexOf(String(b.value))
      return validA - validB
    })
  ]

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode'], provider = activeProfile.provider) =>
    getDefaultModelForProvider(provider, apiMode)

  const wasSettingsOpenRef = useRef(false)

  useEffect(() => {
    if (!showSettings) {
      wasSettingsOpenRef.current = false
      return
    }
    if (wasSettingsOpenRef.current) return

    wasSettingsOpenRef.current = true
    const normalizedSettings = normalizeSettings(settings)
    const displaySettings = normalizedSettings.reuseTaskApiProfileTemporarily && reusedTaskApiProfileId && normalizedSettings.profiles.some((profile) => profile.id === reusedTaskApiProfileId)
      ? normalizeSettings({ ...normalizedSettings, activeProfileId: reusedTaskApiProfileId })
      : normalizedSettings
    setDraft(displaySettings)
    setTimeoutInput(String(getActiveApiProfile(displaySettings).timeout))
    setAgentMaxToolRoundsInput(String(displaySettings.agentMaxToolRounds))
    setShowAdvancedApi(false)
  }, [showSettings, settings, reusedTaskApiProfileId])

  useEffect(() => {
    setTimeoutInput(String(activeProfile.timeout))
  }, [activeProfile.id, activeProfile.timeout])

  useEffect(() => {
    if (showSettings && settingsTabRequest) setActiveTab(settingsTabRequest)
  }, [settingsTabRequest, showSettings])

  const updateProfileMenuMaxHeight = useCallback(() => {
    if (!profileMenuTriggerRef.current) return
    setProfileMenuMaxHeight(getDropdownMaxHeight(profileMenuTriggerRef.current))
  }, [])

  useEffect(() => {
    if (!showProfileMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      if (profileMenuRef.current?.contains(event.target as Node)) return
      setShowProfileMenu(false)
    }

    updateProfileMenuMaxHeight()
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('resize', updateProfileMenuMaxHeight)
    window.addEventListener('scroll', updateProfileMenuMaxHeight, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('resize', updateProfileMenuMaxHeight)
      window.removeEventListener('scroll', updateProfileMenuMaxHeight, true)
    }
  }, [showProfileMenu, updateProfileMenuMaxHeight])

  useEffect(() => () => {
    if (profileImportUrlTooltipTimerRef.current != null) window.clearTimeout(profileImportUrlTooltipTimerRef.current)
    if (duplicateProfileTooltipTimerRef.current != null) window.clearTimeout(duplicateProfileTooltipTimerRef.current)
    if (llmPromptTooltipTimerRef.current != null) window.clearTimeout(llmPromptTooltipTimerRef.current)
  }, [])

  useEffect(() => {
    if (!profileTouchDragPreview) return

    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault()
    }
    const listenerOptions = { passive: false, capture: true } as AddEventListenerOptions
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior

    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    window.addEventListener('touchmove', preventTouchScroll, listenerOptions)

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
      window.removeEventListener('touchmove', preventTouchScroll, listenerOptions)
    }
  }, [profileTouchDragPreview])

  const clearProfileImportUrlTooltipTimer = () => {
    if (profileImportUrlTooltipTimerRef.current != null) {
      window.clearTimeout(profileImportUrlTooltipTimerRef.current)
      profileImportUrlTooltipTimerRef.current = null
    }
  }

  const clearDuplicateProfileTooltipTimer = () => {
    if (duplicateProfileTooltipTimerRef.current != null) {
      window.clearTimeout(duplicateProfileTooltipTimerRef.current)
      duplicateProfileTooltipTimerRef.current = null
    }
  }

  const clearLlmPromptTooltipTimer = () => {
    if (llmPromptTooltipTimerRef.current != null) {
      window.clearTimeout(llmPromptTooltipTimerRef.current)
      llmPromptTooltipTimerRef.current = null
    }
  }

  const commitSettings = (nextDraft: AppSettings) => {
    const normalizedProfiles = nextDraft.profiles.map((profile) => {
      const defaultModel = getDefaultModelForMode(profile.apiMode, profile.provider)
      return {
        ...profile,
        name: profile.name.trim() || (profile.id === DEFAULT_OPENAI_PROFILE_ID ? '默认' : '新配置'),
        baseUrl: '',
        apiKey: '',
        model: profile.model.trim() || defaultModel,
        timeout: Number(profile.timeout) || DEFAULT_SETTINGS.timeout,
        apiMode: profile.provider === 'xAI' ? 'images' : profile.apiMode,
        codexCli: profile.provider === 'openai' ? profile.codexCli : false,
        streamImages: profile.provider === 'openai' ? profile.streamImages : false,
        streamPartialImages: profile.provider === 'openai' ? normalizeStreamPartialImages(profile.streamPartialImages) : DEFAULT_STREAM_PARTIAL_IMAGES,
      }
    })
    const fallbackProfile = createDefaultOpenAIProfile({ id: newId('openai') })
    const normalizedDraft = normalizeSettings({
      ...nextDraft,
      videoDurationSeconds: normalizeVideoDurationSeconds(nextDraft.videoDurationSeconds),
      profiles: normalizedProfiles.length ? normalizedProfiles : [fallbackProfile],
      activeProfileId: normalizedProfiles.some((profile) => profile.id === nextDraft.activeProfileId)
        ? nextDraft.activeProfileId
        : (normalizedProfiles[0]?.id ?? fallbackProfile.id),
    })
    setDraft(normalizedDraft)
    setSettings(normalizedDraft)
  }

  const createProfileImportUrl = (profile: ApiProfile) => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = ''

    if (profile.provider === 'openai') {
      url.searchParams.set('apiMode', profile.apiMode)
      const model = profile.model.trim() || getDefaultModelForMode(profile.apiMode, profile.provider)
      url.searchParams.set('model', model)
      if (profile.codexCli) url.searchParams.set('codexCli', 'true')
      if (profile.streamImages !== DEFAULT_SETTINGS.streamImages) url.searchParams.set('streamImages', String(Boolean(profile.streamImages)))
      if (profile.streamPartialImages !== DEFAULT_STREAM_PARTIAL_IMAGES) url.searchParams.set('streamPartialImages', String(normalizeStreamPartialImages(profile.streamPartialImages)))
      return url.toString()
    }

    const provider = draft.customProviders.find((item) => item.id === profile.provider)
    const importProfile: ApiProfile = {
      ...profile,
      baseUrl: '',
      apiKey: '',
    }
    url.searchParams.set('settings', JSON.stringify({
      customProviders: provider ? [provider] : [],
      profiles: [importProfile],
    }))
    return url.toString()
  }

  const copyProfileImportUrl = async (profile: ApiProfile) => {
    setShowProfileMenu(false)
    setProfileImportUrlTooltipVisible(false)
    try {
      await copyTextToClipboard(createProfileImportUrl(profile))
      showToast('导入 URL 已复制（不含凭据）', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制导入 URL 失败', err), 'error')
    }
  }

  const handleTestConnection = async () => {
    if (testingConnectionProfileId) return

    setTestingConnectionProfileId(activeProfile.id)
    try {
      await testApiConnection(activeProfile)
      showToast('接口连通性测试成功。', 'success')
    } catch (err) {
      showToast(`接口连通性测试失败：${getUserFacingErrorMessage(err, '请检查团队 API 代理是否正常运行', { apiUpstream: true })}`, 'error')
    } finally {
      setTestingConnectionProfileId(null)
    }
  }

  const getDraftWithActiveProfilePatch = (patch: Partial<ApiProfile>) => ({
      ...draft,
      profiles: draft.profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, ...patch } : profile),
    })

  const updateActiveProfile = (patch: Partial<ApiProfile>, commit = false) => {
    const nextDraft = getDraftWithActiveProfilePatch(patch)
    setDraft(nextDraft)
    if (commit) commitSettings(nextDraft)
  }

  const commitActiveProfilePatch = (patch: Partial<ApiProfile>) => {
    const nextDraft = getDraftWithActiveProfilePatch(patch)
    commitSettings(nextDraft)
  }

  const handleClose = () => {
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' || Number.isNaN(nextTimeout)
        ? DEFAULT_SETTINGS.timeout
        : nextTimeout
    const normalizedAgentMaxToolRounds = agentMaxToolRoundsInput.trim() === ''
      ? DEFAULT_AGENT_MAX_TOOL_ROUNDS
      : normalizeAgentMaxToolRounds(agentMaxToolRoundsInput, draft.agentMaxToolRounds)
    const nextDraft = {
      ...draft,
      agentMaxToolRounds: normalizedAgentMaxToolRounds,
      profiles: activeProviderIsOpenAICompatible
        ? draft.profiles.map((profile) =>
            profile.id === activeProfile.id ? { ...profile, timeout: normalizedTimeout } : profile,
          )
        : draft.profiles,
    }
    setAgentMaxToolRoundsInput(String(normalizedAgentMaxToolRounds))
    commitSettings(nextDraft)
    setShowSettings(false)
  }

  const closeCustomProviderImport = () => {
    setShowCustomProviderImport(false)
    setEditingCustomProviderId(null)
  }

  const commitTimeout = useCallback(() => {
    if (!isOpenAICompatibleProvider(draft, activeProfile.provider)) return
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' ? DEFAULT_SETTINGS.timeout : Number.isNaN(nextTimeout) ? activeProfile.timeout : nextTimeout
    setTimeoutInput(String(normalizedTimeout))
    updateActiveProfile({ timeout: normalizedTimeout }, true)
  }, [draft, activeProfile.id, activeProfile.provider, activeProfile.timeout, timeoutInput])

  const commitAgentMaxToolRounds = useCallback(() => {
    const value = agentMaxToolRoundsInput.trim() === ''
      ? DEFAULT_AGENT_MAX_TOOL_ROUNDS
      : normalizeAgentMaxToolRounds(agentMaxToolRoundsInput, draft.agentMaxToolRounds)
    setAgentMaxToolRoundsInput(String(value))
    if (value !== draft.agentMaxToolRounds) commitSettings({ ...draft, agentMaxToolRounds: value })
  }, [agentMaxToolRoundsInput, draft])

  if (!showSettings) return null

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setIsImportingData(true)
      try {
        const imported = await importData(file, { importConfig, importTasks })
        if (imported) {
          const nextDraft = normalizeSettings(useStore.getState().settings)
          setDraft(nextDraft)
          setTimeoutInput(String(getActiveApiProfile(nextDraft).timeout))
          setShowProfileMenu(false)
        }
      } finally {
        setIsImportingData(false)
      }
    }
    e.target.value = ''
  }

  const handleClearAllData = async () => {
    await clearData({ clearConfig, clearTasks })
    const nextDraft = normalizeSettings(useStore.getState().settings)
    setDraft(nextDraft)
    setTimeoutInput(String(getActiveApiProfile(nextDraft).timeout))
    setShowProfileMenu(false)
  }

  const createNewProfile = () => {
    setReusedTaskApiProfile(null)
    const profile = createDefaultOpenAIProfile({ id: newId('openai'), name: '新配置' })
    const nextDraft = normalizeSettings({ 
        ...draft, 
        profiles: [...draft.profiles, profile],
        activeProfileId: profile.id
    })
    commitSettings(nextDraft)
    setShowProfileMenu(false)
  }

  const duplicateActiveProfile = () => {
    setReusedTaskApiProfile(null)
    setDuplicateProfileTooltipVisible(false)
    const profile: ApiProfile = {
      ...activeProfile,
      id: newId(activeProfile.provider === 'openai' ? 'openai' : 'profile'),
      name: `${activeProfile.name}（复制）`,
    }
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: [...draft.profiles, profile],
      activeProfileId: profile.id,
    })
    commitSettings(nextDraft)
    setShowProfileMenu(false)
  }

  const switchProfile = (id: string) => {
    setReusedTaskApiProfile(null)
    const nextDraft = normalizeSettings({ ...draft, activeProfileId: id })
    commitSettings(nextDraft)
    setShowProfileMenu(false)
  }
  
  const handleProfileDragStart = (e: React.DragEvent, id: string) => {
    setDraggedProfileId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }

  const handleProfileDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const targetElement = e.currentTarget as HTMLElement
    const rect = targetElement.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'

    if (dragOverProfileId !== targetId || dragDropPosition !== position) {
      setDragOverProfileId(targetId)
      setDragDropPosition(position)
    }

    const scrollContainer = targetElement.closest('.custom-scrollbar')
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const scrollThreshold = 30

      if (e.clientY < containerRect.top + scrollThreshold) {
        scrollContainer.scrollTop -= 10
      } else if (e.clientY > containerRect.bottom - scrollThreshold) {
        scrollContainer.scrollTop += 10
      }
    }
  }

  const handleProfileDragEnd = () => {
    setDraggedProfileId(null)
    setDragOverProfileId(null)
    setDragDropPosition(null)
    setProfileTouchDragPreview(null)
    profileTouchDragRef.current = null
  }

  const moveProfileToDropTarget = (sourceId: string, targetId: string, position: 'before' | 'after' | null) => {
    if (!sourceId || sourceId === targetId) return

    const sourceIndex = draft.profiles.findIndex((p) => p.id === sourceId)
    const targetIndex = draft.profiles.findIndex((p) => p.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return

    const newProfiles = [...draft.profiles]
    const [removed] = newProfiles.splice(sourceIndex, 1)

    let newTargetIndex = targetIndex
    if (position === 'after') newTargetIndex++
    if (sourceIndex < targetIndex) newTargetIndex--

    newProfiles.splice(newTargetIndex, 0, removed)

    const nextDraft = normalizeSettings({ ...draft, profiles: newProfiles })
    commitSettings(nextDraft)
  }

  const handleProfileDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    moveProfileToDropTarget(e.dataTransfer.getData('text/plain'), targetId, dragDropPosition)
    handleProfileDragEnd()
  }

  const handleProfileTouchStart = (e: React.TouchEvent, profile: ApiProfile) => {
    if (!(e.target as HTMLElement).closest('[data-drag-handle]')) return
    const touch = e.touches[0]
    const rect = e.currentTarget.getBoundingClientRect()

    e.preventDefault()
    e.stopPropagation()
    profileTouchDragRef.current = { id: profile.id, startX: touch.clientX, startY: touch.clientY, moved: false }
    setDraggedProfileId(profile.id)
    setProfileTouchDragPreview({
      label: profile.name,
      providerLabel: getApiProviderLabel(draft, profile.provider),
      x: touch.clientX,
      y: touch.clientY,
      width: rect.width,
      height: rect.height,
      offsetX: touch.clientX - rect.left,
      offsetY: touch.clientY - rect.top,
    })
  }

  const handleProfileTouchMove = (e: React.TouchEvent) => {
    const drag = profileTouchDragRef.current
    if (!drag) return
    const touch = e.touches[0]

    if (!drag.moved) {
      if (Math.abs(touch.clientX - drag.startX) > 5 || Math.abs(touch.clientY - drag.startY) > 5) {
        drag.moved = true
      } else {
        return
      }
    }

    e.preventDefault()
    setProfileTouchDragPreview((current) => current ? { ...current, x: touch.clientX, y: touch.clientY } : current)

    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    const targetElement = el?.closest('[data-profile-id]') as HTMLElement | null
    if (!targetElement) return

    const targetId = targetElement.getAttribute('data-profile-id')
    if (!targetId) return

    const rect = targetElement.getBoundingClientRect()
    const position = touch.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDragOverProfileId(targetId)
    setDragDropPosition(position)

    const scrollContainer = targetElement.closest('.custom-scrollbar') as HTMLElement | null
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const scrollThreshold = 30
      if (touch.clientY < containerRect.top + scrollThreshold) {
        scrollContainer.scrollTop -= 10
      } else if (touch.clientY > containerRect.bottom - scrollThreshold) {
        scrollContainer.scrollTop += 10
      }
    }
  }

  const handleProfileTouchEnd = (e: React.TouchEvent) => {
    const drag = profileTouchDragRef.current
    if (!drag) return
    if (drag.moved && dragOverProfileId && dragOverProfileId !== drag.id) {
      e.preventDefault()
      moveProfileToDropTarget(drag.id, dragOverProfileId, dragDropPosition)
    }
    handleProfileDragEnd()
  }

  const deleteProfile = (id: string) => {
    if (draft.profiles.length <= 1) return
    if (id === reusedTaskApiProfileId) setReusedTaskApiProfile(null)
    const nextProfiles = draft.profiles.filter((item) => item.id !== id)
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: nextProfiles,
      activeProfileId: draft.activeProfileId === id ? nextProfiles[0].id : draft.activeProfileId,
    })
    commitSettings(nextDraft)
  }

  const handleProviderReorder = (sourceValue: string | number, targetValue: string | number, position: 'before' | 'after' | null) => {
    const currentOrder = draft.providerOrder || ['openai', 'xAI', ...draft.customProviders.map(p => p.id)]
    const sourceIndex = currentOrder.indexOf(String(sourceValue))
    const targetIndex = currentOrder.indexOf(String(targetValue))
    if (sourceIndex < 0 || targetIndex < 0) return

    const newOrder = [...currentOrder]
    const [removed] = newOrder.splice(sourceIndex, 1)

    let newTargetIndex = targetIndex
    if (position === 'after') newTargetIndex++
    if (sourceIndex < targetIndex) newTargetIndex--

    newOrder.splice(newTargetIndex, 0, removed)

    const nextDraft = normalizeSettings({ ...draft, providerOrder: newOrder })
    commitSettings(nextDraft)
  }

  const handleProviderTypeChange = (value: string | number) => {
    if (value === ADD_CUSTOM_PROVIDER_VALUE) {
      setEditingCustomProviderId(null)
      setCustomProviderForm(createDefaultCustomProviderForm())
      setShowCustomProviderImport(true)
      setCustomProviderImportError(null)
      return
    }

    const provider = String(value) as ApiProfile['provider']
    const customProvider = draft.customProviders.find((item) => item.id === provider)
    updateActiveProfile(switchApiProfileProvider(activeProfile, provider, customProvider), true)
  }

  const updateCustomProviderForm = (patch: Partial<CustomProviderForm>) => {
    setCustomProviderForm((current) => ({ ...current, ...patch }))
    setCustomProviderImportError(null)
  }

  const buildCustomProviderFromForm = () => {
    const input = customProviderFormToInput(customProviderForm)
    const usedIds = new Set(
      draft.customProviders
        .filter((item) => item.id !== editingCustomProviderId)
        .map((item) => item.id),
    )
    const provider = normalizeCustomProviderDefinition(
      editingCustomProviderId && input && typeof input === 'object'
        ? { ...input, id: editingCustomProviderId }
        : input,
      usedIds,
    )
    if (!provider) throw new Error('自定义服务商配置无效')
    return provider
  }

  function openEditCustomProvider(provider: CustomProviderDefinition) {
    setEditingCustomProviderId(provider.id)
    setCustomProviderForm(customProviderToForm(provider))
    setShowCustomProviderImport(true)
    setCustomProviderImportError(null)
  }

  const saveCustomProvider = () => {
    try {
      const customProvider = buildCustomProviderFromForm()
      if (editingCustomProviderId) {
        const nextDraft = normalizeSettings({
          ...draft,
          customProviders: draft.customProviders.map((provider) =>
            provider.id === editingCustomProviderId ? customProvider : provider,
          ),
        })
        commitSettings(nextDraft)
        setShowCustomProviderImport(false)
        setEditingCustomProviderId(null)
        setCustomProviderImportError(null)
        showToast('服务商配置已更新', 'success')
        return
      }

      const nextProfile = switchApiProfileProvider(activeProfile, customProvider.id, customProvider)
      const nextDraft = normalizeSettings({
        ...draft,
        customProviders: [...draft.customProviders, customProvider],
        profiles: draft.profiles.map((profile) => profile.id === activeProfile.id ? nextProfile : profile),
      })
      commitSettings(nextDraft)
      setShowCustomProviderImport(false)
      setEditingCustomProviderId(null)
      setCustomProviderImportError(null)
    } catch (err) {
      setCustomProviderImportError(getUserFacingErrorMessage(err, '自定义服务商配置无效'))
    }
  }

  function confirmDeleteCustomProvider(provider: CustomProviderDefinition) {
    setConfirmDialog({
      title: '删除服务商',
      message: `确定要删除自定义服务商「${provider.name}」吗？正在使用它的配置会切回 OpenAI 兼容接口。`,
      action: () => deleteCustomProvider(provider),
    })
  }

  function deleteCustomProvider(provider: CustomProviderDefinition) {
    const providerId = provider.id
    const nextDraft = normalizeSettings({
      ...draft,
      customProviders: draft.customProviders.filter((provider) => provider.id !== providerId),
      profiles: draft.profiles.map((profile) =>
        profile.provider === providerId ? switchApiProfileProvider(profile, 'openai') : profile,
      ),
    })
    commitSettings(nextDraft)
    showToast('服务商已删除', 'success')
  }

  const copyCustomProviderLlmPrompt = async () => {
    try {
      await copyTextToClipboard(CUSTOM_PROVIDER_LLM_PROMPT)
      showToast('LLM 生成提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制 LLM 生成提示词失败', err), 'error')
    }
  }

  const handleCustomProviderJsonPaste = async () => {
    setIsImportingJson(true)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        throw new Error('剪贴板为空')
      }
      const imported = importCustomProviderSettingsFromJson(text, draft.customProviders)
      if (imported.profiles.length > 0) {
        const previousProfileIds = new Set(draft.profiles.map((profile) => profile.id))
        const mergedDraft = mergeImportedSettings(draft, imported)
        const importedProfile = getImportedProfileFromMergedSettings(mergedDraft, previousProfileIds, imported)
        const importedProfileAlreadyExisted = previousProfileIds.has(importedProfile.id)
        const shouldReplaceActiveProfile = !editingCustomProviderId && isPristineNewOpenAIProfile(activeProfile) && !importedProfileAlreadyExisted
        const switchedToExistingProfile = !shouldReplaceActiveProfile && importedProfileAlreadyExisted
        const nextDraft = shouldReplaceActiveProfile
          ? normalizeSettings({
              ...mergedDraft,
              profiles: mergedDraft.profiles
                .filter((profile) => profile.id === activeProfile.id || profile.id !== importedProfile.id)
                .map((profile) => profile.id === activeProfile.id ? { ...importedProfile, id: activeProfile.id } : profile),
              activeProfileId: activeProfile.id,
            })
          : normalizeSettings({
              ...mergedDraft,
              activeProfileId: importedProfile.id,
            })
        setDraft(nextDraft)
        setSettings(nextDraft)
        setTimeoutInput(String(getActiveApiProfile(nextDraft).timeout))
        setShowCustomProviderImport(false)
        setEditingCustomProviderId(null)
        setCustomProviderImportError(null)
        showToast(shouldReplaceActiveProfile ? '已覆盖当前空配置' : switchedToExistingProfile ? '已存在相同配置，已切换到已有配置' : 'JSON 配置已导入并切换', 'success')
        return
      }

      const provider = imported.customProviders[0]
      setCustomProviderForm(customProviderToForm(provider))
      setCustomProviderImportError(null)
      showToast('JSON 配置已导入', 'success')
    } catch (err) {
      const msg = getUserFacingErrorMessage(err, '导入 JSON 配置失败')
      setCustomProviderImportError(null)
      if (err instanceof Error && err.name === 'NotAllowedError') {
        showToast('无法读取剪贴板，请允许浏览器访问剪贴板，或直接粘贴到输入框中', 'error')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setIsImportingJson(false)
    }
  }

  return (
    <>
      <ModalShell
        onClose={handleClose}
        scrollRef={settingsScrollBoundaryRef}
        panelRef={settingsScrollBoundaryRef}
        zIndexClass="z-[70]"
        panelClassName="w-full max-w-3xl rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex h-[85vh] sm:h-[600px] flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between shrink-0 p-5 border-b border-gray-100 dark:border-white/[0.08]">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            设置
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400 dark:text-gray-500 font-mono select-none">v{__APP_VERSION__}</span>
            <button
              onClick={handleClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
          {/* Sidebar */}
          <div className="w-full sm:w-48 shrink-0 flex flex-col border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-white/[0.08] bg-gray-50/50 dark:bg-white/[0.02]">
            <nav className="grid grid-cols-5 gap-1 p-2 sm:flex sm:flex-1 sm:flex-col sm:gap-0 sm:space-y-1 sm:overflow-y-auto sm:p-3 custom-scrollbar">
              <button
                onClick={() => setActiveTab('api')}
                className={`min-w-0 flex items-center justify-center gap-0 rounded-xl px-1.5 py-2.5 text-xs transition-colors sm:flex-shrink-0 sm:justify-start sm:gap-2.5 sm:px-3 sm:text-sm ${activeTab === 'api' ? 'bg-white dark:bg-white/[0.08] shadow-sm text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100/80 dark:hover:bg-white/[0.04]'}`}
              >
                <svg className="hidden h-4 w-4 sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                <span className="hidden sm:inline">API 与模型</span>
                <span className="sm:hidden">API</span>
              </button>
              <button
                onClick={() => setActiveTab('general')}
                className={`min-w-0 flex items-center justify-center gap-0 rounded-xl px-1.5 py-2.5 text-xs transition-colors sm:flex-shrink-0 sm:justify-start sm:gap-2.5 sm:px-3 sm:text-sm ${activeTab === 'general' ? 'bg-white dark:bg-white/[0.08] shadow-sm text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100/80 dark:hover:bg-white/[0.04]'}`}
              >
                <svg className="hidden h-4 w-4 sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
                </svg>
                <span className="hidden sm:inline">习惯配置</span>
                <span className="sm:hidden">习惯</span>
              </button>
              <button
                onClick={() => setActiveTab('agent')}
                className={`min-w-0 flex items-center justify-center gap-0 rounded-xl px-1.5 py-2.5 text-xs transition-colors sm:flex-shrink-0 sm:justify-start sm:gap-2.5 sm:px-3 sm:text-sm ${activeTab === 'agent' ? 'bg-white dark:bg-white/[0.08] shadow-sm text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100/80 dark:hover:bg-white/[0.04]'}`}
              >
                <svg className="hidden h-4 w-4 sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8V4H8" />
                  <rect width="16" height="12" x="4" y="8" rx="2" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 14h2M20 14h2M15 13v2M9 13v2" />
                </svg>
                <span className="hidden sm:inline">Agent 配置</span>
                <span className="sm:hidden">Agent</span>
              </button>
              <button
                onClick={() => setActiveTab('data')}
                className={`min-w-0 flex items-center justify-center gap-0 rounded-xl px-1.5 py-2.5 text-xs transition-colors sm:flex-shrink-0 sm:justify-start sm:gap-2.5 sm:px-3 sm:text-sm ${activeTab === 'data' ? 'bg-white dark:bg-white/[0.08] shadow-sm text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100/80 dark:hover:bg-white/[0.04]'}`}
              >
                <svg className="hidden h-4 w-4 sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                </svg>
                <span className="hidden sm:inline">数据管理</span>
                <span className="sm:hidden">数据</span>
              </button>
              <button
                onClick={() => setActiveTab('about')}
                className={`min-w-0 flex items-center justify-center gap-0 rounded-xl px-1.5 py-2.5 text-xs transition-colors sm:flex-shrink-0 sm:justify-start sm:gap-2.5 sm:px-3 sm:text-sm ${activeTab === 'about' ? 'bg-white dark:bg-white/[0.08] shadow-sm text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100/80 dark:hover:bg-white/[0.04]'}`}
              >
                <svg className="hidden h-4 w-4 sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                关于
              </button>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-transparent relative overflow-hidden">
            <div className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar p-5 sm:p-6">
            {activeTab === 'general' && (
              <SettingsGeneralSection draft={draft} commitSettings={commitSettings} />
            )}

            {activeTab === 'agent' && (
              <SettingsAgentSection
                draft={draft}
                commitSettings={commitSettings}
                agentMaxToolRoundsInput={agentMaxToolRoundsInput}
                setAgentMaxToolRoundsInput={setAgentMaxToolRoundsInput}
                commitAgentMaxToolRounds={commitAgentMaxToolRounds}
              />
            )}
            
            {activeTab === 'api' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className="block text-sm text-gray-600 dark:text-gray-300">当前连接配置</span>
                    <span className="relative inline-flex">
                      <button
                        type="button"
                        onClick={() => copyProfileImportUrl(activeProfile)}
                        onMouseEnter={() => setProfileImportUrlTooltipVisible(true)}
                        onMouseLeave={() => setProfileImportUrlTooltipVisible(false)}
                        onFocus={() => setProfileImportUrlTooltipVisible(true)}
                        onBlur={() => setProfileImportUrlTooltipVisible(false)}
                        onTouchStart={() => {
                          clearProfileImportUrlTooltipTimer()
                          profileImportUrlTooltipTimerRef.current = window.setTimeout(() => {
                            setProfileImportUrlTooltipVisible(true)
                            profileImportUrlTooltipTimerRef.current = null
                          }, 450)
                        }}
                        onTouchEnd={clearProfileImportUrlTooltipTimer}
                        onTouchCancel={clearProfileImportUrlTooltipTimer}
                        className="flex h-5 w-5 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                        aria-label={`复制导入配置「${activeProfile.name}」的 URL`}
                      >
                        <LinkIcon className="h-3.5 w-3.5" />
                      </button>
                      <ViewportTooltip visible={profileImportUrlTooltipVisible} className="whitespace-nowrap">
                        复制导入 URL
                      </ViewportTooltip>
                    </span>
                    <span className="relative inline-flex">
                      <button
                        type="button"
                        onClick={duplicateActiveProfile}
                        onMouseEnter={() => setDuplicateProfileTooltipVisible(true)}
                        onMouseLeave={() => setDuplicateProfileTooltipVisible(false)}
                        onFocus={() => setDuplicateProfileTooltipVisible(true)}
                        onBlur={() => setDuplicateProfileTooltipVisible(false)}
                        onTouchStart={() => {
                          clearDuplicateProfileTooltipTimer()
                          duplicateProfileTooltipTimerRef.current = window.setTimeout(() => {
                            setDuplicateProfileTooltipVisible(true)
                            duplicateProfileTooltipTimerRef.current = null
                          }, 450)
                        }}
                        onTouchEnd={clearDuplicateProfileTooltipTimer}
                        onTouchCancel={clearDuplicateProfileTooltipTimer}
                        className="flex h-5 w-5 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                        aria-label={`复制一份配置「${activeProfile.name}」`}
                      >
                        <CopyIcon className="h-3.5 w-3.5" />
                      </button>
                      <ViewportTooltip visible={duplicateProfileTooltipVisible} className="whitespace-nowrap">
                        复制当前配置
                      </ViewportTooltip>
                    </span>
                  </div>
                  <div ref={profileMenuRef} className="relative">
                    <button
                      ref={profileMenuTriggerRef}
                      type="button"
                      onClick={() => {
                        if (!showProfileMenu) updateProfileMenuMaxHeight()
                        setShowProfileMenu(!showProfileMenu)
                      }}
                      className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                      title={activeProfile.name}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">{activeProfile.name}</span>
                        <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                          {getApiProviderLabel(draft, activeProfile.provider)}
                        </span>
                      </span>
                      <ChevronDownIcon className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200 ${showProfileMenu ? 'rotate-180' : ''}`} />
                    </button>
                    
                    {showProfileMenu && (
                      <>
                        <div
                          className="absolute right-0 top-full z-50 mt-1.5 w-full overflow-hidden overflow-y-auto rounded-xl border border-gray-200/60 bg-white/95 py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-dropdown-down dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10 custom-scrollbar"
                          style={{ maxHeight: profileMenuMaxHeight }}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault()
                              createNewProfile()
                            }}
                            className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
                          >
                            <span className="truncate font-semibold">创建新配置</span>
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                              <PlusIcon className="h-4 w-4" />
                            </span>
                          </button>
                          <div>
                            {draft.profiles.map(profile => (
                              <div
                                key={profile.id}
                                data-profile-id={profile.id}
                                title={profile.name}
                                draggable
                                onDragStart={(e) => handleProfileDragStart(e, profile.id)}
                                onDragOver={(e) => handleProfileDragOver(e, profile.id)}
                                onDrop={(e) => handleProfileDrop(e, profile.id)}
                                onDragEnd={handleProfileDragEnd}
                                onTouchStart={(e) => handleProfileTouchStart(e, profile)}
                                onTouchMove={handleProfileTouchMove}
                                onTouchEnd={handleProfileTouchEnd}
                                onTouchCancel={handleProfileDragEnd}
                                onClick={(e) => {
                                  // Don't switch profile if they are clicking the drag handle
                                  if ((e.target as HTMLElement).closest('[data-drag-handle]')) return
                                  e.preventDefault()
                                  switchProfile(profile.id)
                                }}
                                className={`relative group flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-xs transition-colors ${draggedProfileId === profile.id ? 'opacity-40 bg-gray-100 dark:bg-white/[0.04]' : profile.id === activeProfile.id ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
                              >
                                {dragOverProfileId === profile.id && dragDropPosition === 'before' && draggedProfileId !== profile.id && (
                                  <div className="absolute -top-[1px] left-0 right-0 h-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
                                )}
                                {dragOverProfileId === profile.id && dragDropPosition === 'after' && draggedProfileId !== profile.id && (
                                  <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
                                )}
                                <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                                  <div
                                    data-drag-handle
                                    className="flex cursor-grab active:cursor-grabbing items-center justify-center text-gray-400 opacity-60 transition-opacity hover:opacity-100 dark:text-gray-500"
                                    style={{ touchAction: 'none' }}
                                    title="拖拽排序"
                                  >
                                    <DragHandleIcon className="h-3.5 w-3.5" />
                                  </div>
                                  <span className="min-w-0 truncate">{profile.name}</span>
                                  <span className={`rounded px-1.5 py-0.5 text-[10px] shrink-0 ${profile.id === activeProfile.id ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' : 'bg-gray-100 text-gray-500 dark:bg-white/[0.08] dark:text-gray-400'}`}>
                                    {getApiProviderLabel(draft, profile.provider)}
                                  </span>
                                </div>
                                
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      copyProfileImportUrl(profile)
                                    }}
                                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 opacity-60 transition-all hover:bg-gray-100 hover:text-gray-600 hover:opacity-100 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                                    aria-label={`复制导入配置「${profile.name}」的 URL`}
                                    title="复制导入 URL"
                                  >
                                    <LinkIcon className="h-3.5 w-3.5" />
                                  </button>
                                  {draft.profiles.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        setConfirmDialog({
                                          title: '删除配置',
                                          message: `确定要删除配置「${profile.name}」吗？`,
                                          action: () => deleteProfile(profile.id)
                                        })
                                      }}
                                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 opacity-60 transition-all hover:bg-red-50 hover:text-red-500 hover:opacity-100 dark:hover:bg-red-500/10"
                                      aria-label="删除配置"
                                    >
                                      <TrashIcon className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

              {/* 1. 配置名称 */}
              <label className="block">
                <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">配置名称（仅本地显示）</span>
                <input
                  value={activeProfile.name}
                  onChange={(e) => updateActiveProfile({ name: e.target.value })}
                  onBlur={(e) => commitActiveProfilePatch({ name: e.target.value })}
                  type="text"
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              {/* 2. 服务商类型 */}
              <div className="block">
                <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">服务商</span>
                <Select
                  value={activeProfile.provider}
                  onChange={handleProviderTypeChange}
                  onReorder={handleProviderReorder}
                  options={providerOptions}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </div>

              {/* 模型 ID */}
              <label className="block">
                <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">
                  模型 ID（上游模型名称）
                </span>
                <input
                  value={activeProfile.model}
                  onChange={(e) => updateActiveProfile({ model: e.target.value })}
                  onBlur={(e) => commitActiveProfilePatch({ model: e.target.value })}
                  type="text"
                  placeholder={getDefaultModelForMode(activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
                <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
                  {activeCustomProvider ? (
                    <>当前使用 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{activeCustomProvider.name}</code>。</>
                  ) : activeProfile.provider === 'xAI' ? (
                    <>xAI Images API 可使用 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">grok-imagine-image</code> 或 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_XAI_IMAGES_MODEL}</code>。</>
                  ) : (activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode) === 'responses' ? (
                    <>Responses API 需要使用支持 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">image_generation</code> 工具的文本模型，例如 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_RESPONSES_MODEL}</code>。</>
                  ) : (
                    <>Images API 需要使用 GPT Image 模型，例如 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_IMAGES_MODEL}</code>。</>
                  )}
                  {activeProfile.provider === 'openai' && (
                    <>支持通过查询参数覆盖：<code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">?model=</code>。</>
                  )}
                </div>
              </label>

              <div className="block rounded-xl border border-gray-200/60 bg-white/45 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-200">接口连通性测试</div>
                    <div data-selectable-text className="mt-1 text-xs text-gray-500 dark:text-gray-500">
                      发送轻量测试请求，验证团队 API 代理是否可用，不会生成图片。
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testingConnectionProfileId === activeProfile.id}
                    className="shrink-0 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-600 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/15"
                  >
                    {testingConnectionProfileId === activeProfile.id ? '测试中...' : '测试连通性'}
                  </button>
                </div>
              </div>

              {activeProviderIsOpenAICompatible && (
                <>
                  <div className="border-t border-gray-200/60 pt-2 dark:border-white/[0.06]">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedApi((v) => !v)}
                      aria-expanded={showAdvancedApi}
                      className="flex w-full items-center justify-between rounded-lg py-1.5 text-sm font-medium text-gray-600 transition hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
                    >
                      <span>高级选项</span>
                      <ChevronDownIcon className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${showAdvancedApi ? 'rotate-180' : ''}`} />
                    </button>
                  </div>

                  {showAdvancedApi && (
                    <>
                      {activeProfile.provider === 'openai' && (
                        <div className="block">
                          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">接口模式</span>
                          <Select
                            value={activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode}
                            onChange={(value) => {
                              const apiMode = value as AppSettings['apiMode']
                              const nextModel =
                                activeProfile.model === DEFAULT_IMAGES_MODEL || activeProfile.model === DEFAULT_RESPONSES_MODEL
                                  ? getDefaultModelForMode(apiMode, 'openai')
                                  : activeProfile.model
                              updateActiveProfile({ apiMode, model: nextModel }, true)
                            }}
                            options={[
                              { label: 'Images API（图像接口）', value: 'images' },
                              { label: 'Responses API（对话接口）', value: 'responses' },
                            ]}
                            className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                          />
                          <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
                            生成图片用 Images API；Agent 对话用 Responses API。
                          </div>
                        </div>
                      )}

                      {activeProfile.provider === 'openai' && (
                        <div className="block space-y-3">
                          <div>
                            <div className="mb-1.5 flex items-center justify-between gap-3">
                              <span className="block text-sm text-gray-600 dark:text-gray-300">流式返回</span>
                              <button
                                type="button"
                                onClick={() => updateActiveProfile({ streamImages: !activeProfile.streamImages }, true)}
                                className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${activeProfile.streamImages ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                role="switch"
                                aria-checked={!!activeProfile.streamImages}
                                aria-label="流式返回"
                              >
                                <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${activeProfile.streamImages ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
                              </button>
                            </div>
                            <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                              更早看到中间结果；官方流式不发心跳，建议同时设置中间图数量避免代理超时。
                            </div>
                          </div>
                          <label className={`block ${activeProfile.streamImages ? '' : 'opacity-60'}`}>
                            <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">流式中间图数量</span>
                            <Select
                              value={normalizeStreamPartialImages(activeProfile.streamPartialImages)}
                              onChange={(value) => updateActiveProfile({ streamPartialImages: normalizeStreamPartialImages(value) }, true)}
                              disabled={!activeProfile.streamImages}
                              options={[
                                { label: '0，不请求', value: 0 },
                                { label: '1 张', value: 1 },
                                { label: '2 张', value: 2 },
                                { label: '3 张', value: 3 },
                              ]}
                              className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                            />
                            <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
                              对应 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">partial_images</code>。设为 0 时无中间数据，长任务易被代理超时断开。
                            </div>
                          </label>
                        </div>
                      )}

                      {activeProfile.provider !== 'xAI' && (
                        <div className="block">
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="block text-sm text-gray-600 dark:text-gray-300">直接返回图片数据（Base64）</span>
                            <button
                              type="button"
                              onClick={() => updateActiveProfile({ responseFormatB64Json: !activeProfile.responseFormatB64Json }, true)}
                              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${activeProfile.responseFormatB64Json ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                              role="switch"
                              aria-checked={!!activeProfile.responseFormatB64Json}
                              aria-label="直接返回图片数据（Base64）"
                            >
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${activeProfile.responseFormatB64Json ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
                            </button>
                          </div>
                          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                            接口直接返回 Base64，避免 URL 跨域或过期；并非所有服务商支持。
                          </div>
                        </div>
                      )}

                      {activeProfile.provider === 'openai' && (
                        <div className="block">
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="block text-sm text-gray-600 dark:text-gray-300">Codex CLI 兼容</span>
                            <button
                              type="button"
                              onClick={() => updateActiveProfile({ codexCli: !activeProfile.codexCli }, true)}
                              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${activeProfile.codexCli ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                              role="switch"
                              aria-checked={activeProfile.codexCli}
                              aria-label="Codex CLI 兼容"
                            >
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${activeProfile.codexCli ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
                            </button>
                          </div>
                          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                            避开 Codex CLI 不支持的参数，并兼容多图生成。
                          </div>
                        </div>
                      )}

                      <label className="block">
                        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">请求超时（秒）</span>
                        <input
                          value={timeoutInput}
                          onChange={(e) => setTimeoutInput(e.target.value)}
                          onBlur={commitTimeout}
                          type="number"
                          min={10}
                          max={600}
                          className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                        />
                      </label>
                    </>
                  )}
                </>
              )}
            </div>
            )}
            
            {activeTab === 'data' && (
              <SettingsDataSection
                exportConfig={exportConfig}
                setExportConfig={setExportConfig}
                exportTasks={exportTasks}
                setExportTasks={setExportTasks}
                importConfig={importConfig}
                setImportConfig={setImportConfig}
                importTasks={importTasks}
                setImportTasks={setImportTasks}
                clearConfig={clearConfig}
                setClearConfig={setClearConfig}
                clearTasks={clearTasks}
                setClearTasks={setClearTasks}
                isImportingData={isImportingData}
                importInputRef={importInputRef}
                handleImport={handleImport}
                handleClearAllData={handleClearAllData}
                setConfirmDialog={setConfirmDialog}
              />
            )}

            {activeTab === 'about' && (
              <SettingsAboutSection />
            )}
          </div>
          </div>
        </div>
      </ModalShell>

      {showCustomProviderImport && (
        <SettingsCustomProviderModal
          closeCustomProviderImport={closeCustomProviderImport}
          customProviderScrollBoundaryRef={customProviderScrollBoundaryRef}
          editingCustomProviderId={editingCustomProviderId}
          copyCustomProviderLlmPrompt={copyCustomProviderLlmPrompt}
          llmPromptTooltipVisible={llmPromptTooltipVisible}
          setLlmPromptTooltipVisible={setLlmPromptTooltipVisible}
          clearLlmPromptTooltipTimer={clearLlmPromptTooltipTimer}
          llmPromptTooltipTimerRef={llmPromptTooltipTimerRef}
          handleCustomProviderJsonPaste={handleCustomProviderJsonPaste}
          isImportingJson={isImportingJson}
          customProviderForm={customProviderForm}
          updateCustomProviderForm={updateCustomProviderForm}
          customProviderImportError={customProviderImportError}
          saveCustomProvider={saveCustomProvider}
        />
      )}
      {profileTouchDragPreview && createPortal(
          <div
            className="fixed pointer-events-none z-[110] flex items-center justify-between gap-2 rounded-xl bg-white/95 px-3 py-2 text-xs text-gray-700 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:bg-gray-900/95 dark:text-gray-300 dark:ring-white/10"
            style={{
              left: profileTouchDragPreview.x - profileTouchDragPreview.offsetX,
              top: profileTouchDragPreview.y - profileTouchDragPreview.offsetY,
              width: profileTouchDragPreview.width,
              minHeight: profileTouchDragPreview.height,
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
              <DragHandleIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
              <span className="min-w-0 truncate">{profileTouchDragPreview.label}</span>
              <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                {profileTouchDragPreview.providerLabel}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
