import { type ComponentProps, type Dispatch, type DragEvent, type RefObject, type SetStateAction, type TouchEvent } from 'react'
import {
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_XAI_IMAGES_MODEL,
  getApiProviderLabel,
  normalizeStreamPartialImages,
} from '../../lib/apiProfiles'
import type { AppState } from '../../store'
import type { ApiProfile, AppSettings, CustomProviderDefinition } from '../../types'
import Select from '../Select'
import ViewportTooltip from '../ViewportTooltip'
import { ChevronDownIcon, CopyIcon, DragHandleIcon, LinkIcon, PlusIcon, TrashIcon } from '../icons'

// 「API 与模型」设置页（由 SettingsModal 抽出）。配置下拉菜单、tooltip、拖拽与高级选项的
// 状态和处理器仍由父组件持有，以同名 props 透传，故内部 JSX 与原实现逐字节一致、行为严格等价。
export default function SettingsApiSection({
  draft,
  activeProfile,
  activeCustomProvider,
  activeProviderIsOpenAICompatible,
  providerOptions,
  handleProviderTypeChange,
  handleProviderReorder,
  getDefaultModelForMode,
  updateActiveProfile,
  commitActiveProfilePatch,
  copyProfileImportUrl,
  duplicateActiveProfile,
  createNewProfile,
  switchProfile,
  deleteProfile,
  setConfirmDialog,
  profileMenuRef,
  profileMenuTriggerRef,
  showProfileMenu,
  setShowProfileMenu,
  updateProfileMenuMaxHeight,
  profileMenuMaxHeight,
  profileImportUrlTooltipVisible,
  setProfileImportUrlTooltipVisible,
  clearProfileImportUrlTooltipTimer,
  profileImportUrlTooltipTimerRef,
  duplicateProfileTooltipVisible,
  setDuplicateProfileTooltipVisible,
  clearDuplicateProfileTooltipTimer,
  duplicateProfileTooltipTimerRef,
  draggedProfileId,
  dragOverProfileId,
  dragDropPosition,
  handleProfileDragStart,
  handleProfileDragOver,
  handleProfileDrop,
  handleProfileDragEnd,
  handleProfileTouchStart,
  handleProfileTouchMove,
  handleProfileTouchEnd,
  handleTestConnection,
  testingConnectionProfileId,
  showAdvancedApi,
  setShowAdvancedApi,
  timeoutInput,
  setTimeoutInput,
  commitTimeout,
}: {
  draft: AppSettings
  activeProfile: ApiProfile
  activeCustomProvider: CustomProviderDefinition | undefined
  activeProviderIsOpenAICompatible: boolean
  providerOptions: ComponentProps<typeof Select>['options']
  handleProviderTypeChange: (value: string | number) => void
  handleProviderReorder: (sourceValue: string | number, targetValue: string | number, position: 'before' | 'after' | null) => void
  getDefaultModelForMode: (apiMode: AppSettings['apiMode'], provider?: ApiProfile['provider']) => string
  updateActiveProfile: (patch: Partial<ApiProfile>, commit?: boolean) => void
  commitActiveProfilePatch: (patch: Partial<ApiProfile>) => void
  copyProfileImportUrl: (profile: ApiProfile) => void
  duplicateActiveProfile: () => void
  createNewProfile: () => void
  switchProfile: (id: string) => void
  deleteProfile: (id: string) => void
  setConfirmDialog: AppState['setConfirmDialog']
  profileMenuRef: RefObject<HTMLDivElement | null>
  profileMenuTriggerRef: RefObject<HTMLButtonElement | null>
  showProfileMenu: boolean
  setShowProfileMenu: (v: boolean) => void
  updateProfileMenuMaxHeight: () => void
  profileMenuMaxHeight: number
  profileImportUrlTooltipVisible: boolean
  setProfileImportUrlTooltipVisible: (v: boolean) => void
  clearProfileImportUrlTooltipTimer: () => void
  profileImportUrlTooltipTimerRef: RefObject<number | null>
  duplicateProfileTooltipVisible: boolean
  setDuplicateProfileTooltipVisible: (v: boolean) => void
  clearDuplicateProfileTooltipTimer: () => void
  duplicateProfileTooltipTimerRef: RefObject<number | null>
  draggedProfileId: string | null
  dragOverProfileId: string | null
  dragDropPosition: 'before' | 'after' | null
  handleProfileDragStart: (e: DragEvent, id: string) => void
  handleProfileDragOver: (e: DragEvent, targetId: string) => void
  handleProfileDrop: (e: DragEvent, targetId: string) => void
  handleProfileDragEnd: () => void
  handleProfileTouchStart: (e: TouchEvent, profile: ApiProfile) => void
  handleProfileTouchMove: (e: TouchEvent) => void
  handleProfileTouchEnd: (e: TouchEvent) => void
  handleTestConnection: () => void
  testingConnectionProfileId: string | null
  showAdvancedApi: boolean
  setShowAdvancedApi: Dispatch<SetStateAction<boolean>>
  timeoutInput: string
  setTimeoutInput: (v: string) => void
  commitTimeout: () => void
}) {
  return (
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
  )
}
