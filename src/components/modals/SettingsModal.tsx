import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore, importData, clearData, type SettingsTab } from '../../store'
import {
  createDefaultOpenAIProfile,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_SETTINGS,
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
} from '../../lib/shared/apiProfiles'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../lib/ui/clipboard'
import { testApiConnection } from '../../lib/image/apiConnectionTest'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type CustomProviderDefinition } from '../../types'
import { DEFAULT_DROPDOWN_MAX_HEIGHT, getDropdownMaxHeight } from '../../lib/ui/dropdown'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import ModalShell from '../ui/ModalShell'
import { CloseIcon } from '../ui/icons'
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
} from '../settingsModal/constants'
import SettingsGeneralSection from '../settingsModal/SettingsGeneralSection'
import SettingsAgentSection from '../settingsModal/SettingsAgentSection'
import SettingsAboutSection from '../settingsModal/SettingsAboutSection'
import SettingsApiSection from '../settingsModal/SettingsApiSection'
import SettingsDataSection from '../settingsModal/SettingsDataSection'
import SettingsCustomProviderModal from '../settingsModal/SettingsCustomProviderModal'
import SettingsProfileTouchDragPreview from '../settingsModal/SettingsProfileTouchDragPreview'
import { useProfileDrag } from '../settingsModal/useProfileDrag'

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

  const {
    draggedProfileId,
    dragOverProfileId,
    dragDropPosition,
    profileTouchDragPreview,
    handleProfileDragStart,
    handleProfileDragOver,
    handleProfileDragEnd,
    handleProfileDrop,
    handleProfileTouchStart,
    handleProfileTouchMove,
    handleProfileTouchEnd,
  } = useProfileDrag({ draft, commitSettings })

  const createProfileImportUrl = (profile: ApiProfile) => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = ''

    if (profile.provider === 'openai') {
      url.searchParams.set('apiMode', profile.apiMode)
      const model = profile.model.trim() || getDefaultModelForMode(profile.apiMode, profile.provider)
      url.searchParams.set('model', model)
      if (profile.upstreamMode === 'api' || profile.upstreamMode === 'reverse') url.searchParams.set('upstreamMode', profile.upstreamMode)
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
              <SettingsApiSection
                draft={draft}
                activeProfile={activeProfile}
                activeCustomProvider={activeCustomProvider}
                activeProviderIsOpenAICompatible={activeProviderIsOpenAICompatible}
                providerOptions={providerOptions}
                handleProviderTypeChange={handleProviderTypeChange}
                handleProviderReorder={handleProviderReorder}
                getDefaultModelForMode={getDefaultModelForMode}
                updateActiveProfile={updateActiveProfile}
                commitActiveProfilePatch={commitActiveProfilePatch}
                copyProfileImportUrl={copyProfileImportUrl}
                duplicateActiveProfile={duplicateActiveProfile}
                createNewProfile={createNewProfile}
                switchProfile={switchProfile}
                deleteProfile={deleteProfile}
                setConfirmDialog={setConfirmDialog}
                profileMenuRef={profileMenuRef}
                profileMenuTriggerRef={profileMenuTriggerRef}
                showProfileMenu={showProfileMenu}
                setShowProfileMenu={setShowProfileMenu}
                updateProfileMenuMaxHeight={updateProfileMenuMaxHeight}
                profileMenuMaxHeight={profileMenuMaxHeight}
                profileImportUrlTooltipVisible={profileImportUrlTooltipVisible}
                setProfileImportUrlTooltipVisible={setProfileImportUrlTooltipVisible}
                clearProfileImportUrlTooltipTimer={clearProfileImportUrlTooltipTimer}
                profileImportUrlTooltipTimerRef={profileImportUrlTooltipTimerRef}
                duplicateProfileTooltipVisible={duplicateProfileTooltipVisible}
                setDuplicateProfileTooltipVisible={setDuplicateProfileTooltipVisible}
                clearDuplicateProfileTooltipTimer={clearDuplicateProfileTooltipTimer}
                duplicateProfileTooltipTimerRef={duplicateProfileTooltipTimerRef}
                draggedProfileId={draggedProfileId}
                dragOverProfileId={dragOverProfileId}
                dragDropPosition={dragDropPosition}
                handleProfileDragStart={handleProfileDragStart}
                handleProfileDragOver={handleProfileDragOver}
                handleProfileDrop={handleProfileDrop}
                handleProfileDragEnd={handleProfileDragEnd}
                handleProfileTouchStart={handleProfileTouchStart}
                handleProfileTouchMove={handleProfileTouchMove}
                handleProfileTouchEnd={handleProfileTouchEnd}
                handleTestConnection={handleTestConnection}
                testingConnectionProfileId={testingConnectionProfileId}
                showAdvancedApi={showAdvancedApi}
                setShowAdvancedApi={setShowAdvancedApi}
                timeoutInput={timeoutInput}
                setTimeoutInput={setTimeoutInput}
                commitTimeout={commitTimeout}
              />
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
      {profileTouchDragPreview && (
        <SettingsProfileTouchDragPreview profileTouchDragPreview={profileTouchDragPreview} />
      )}
    </>
  )
}
