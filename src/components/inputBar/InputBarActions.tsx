import { useState, type RefObject } from 'react'
import type { MaskDraft, MultiImageMode } from '../../types'
import ButtonTooltip from './ButtonTooltip'

export type InputBarActionsProps = {
  variant: 'desktop' | 'mobile'
  atImageLimit: boolean
  uploadImageTooltipText: string
  activeAgentIsRunning: boolean
  hasSubmitApiConfig: boolean
  canSubmit: boolean
  submitButtonAriaLabel: string
  submitTooltipText: string
  maskDraft: MaskDraft | null
  fileInputRef: RefObject<HTMLInputElement | null>
  cameraInputRef: RefObject<HTMLInputElement | null>
  /** 多图发送模式（拆分按钮）：参考图 ≥2 张、无遮罩、非 Agent 模式时为 true */
  canPerImageSplit?: boolean
  activeMultiImageMode?: MultiImageMode
  /** 「每张各生成」模式将产出的图片数（= 参考图数 × 数量） */
  perImageOutputCount?: number
  /** 「合成一张」模式将产出的图片数（= 数量） */
  mergeOutputCount?: number
  /** 仅切换发送模式（改变主按钮功能），不触发发送 */
  onSelectMode?: (mode: MultiImageMode) => void
  onSubmit: () => void
  onStopAgent: () => void
  onOpenSettings: () => void
}

function SubmitIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
    </svg>
  )
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="currentColor" viewBox="0 0 24 24">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  )
}

function AttachIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  )
}

function CaretIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  )
}

export default function InputBarActions({
  variant,
  atImageLimit,
  uploadImageTooltipText,
  activeAgentIsRunning,
  hasSubmitApiConfig,
  canSubmit,
  submitButtonAriaLabel,
  submitTooltipText,
  maskDraft,
  fileInputRef,
  cameraInputRef,
  canPerImageSplit = false,
  activeMultiImageMode = 'each',
  perImageOutputCount = 0,
  mergeOutputCount = 0,
  onSelectMode,
  onSubmit,
  onStopAgent,
  onOpenSettings,
}: InputBarActionsProps) {
  const [submitHover, setSubmitHover] = useState(false)
  const [attachHover, setAttachHover] = useState(false)
  const [showMobileUploadMenu, setShowMobileUploadMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)

  const handleSubmitClick = () => {
    if (activeAgentIsRunning) {
      onStopAgent()
      return
    }
    if (hasSubmitApiConfig) {
      onSubmit()
      return
    }
    onOpenSettings()
  }

  const attachButtonClass = variant === 'desktop'
    ? `p-2.5 rounded-xl transition-all shadow-sm ${
        atImageLimit
          ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
          : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow'
      }`
    : `p-2.5 rounded-xl transition-all shadow-sm flex-shrink-0 ${
        atImageLimit
          ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
          : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300'
      }`

  const submitButtonClass = variant === 'desktop'
    ? `p-2.5 rounded-xl transition-all shadow-sm hover:shadow ${
        activeAgentIsRunning
          ? 'bg-red-500 text-white hover:bg-red-600'
          : !hasSubmitApiConfig
          ? 'bg-gray-300 dark:bg-white/[0.06] text-white cursor-pointer'
          : 'bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed'
      }`
    : `w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all shadow-sm ${
        activeAgentIsRunning
          ? 'bg-red-500 text-white hover:bg-red-600'
          : !hasSubmitApiConfig
          ? 'bg-gray-300 dark:bg-white/[0.06] text-white cursor-pointer'
          : 'bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed'
      }`

  const submitDisabled = activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false
  const showSubmitTooltip = (activeAgentIsRunning || !hasSubmitApiConfig) && submitHover

  const attachButton = (
    <div
      className="relative"
      onMouseEnter={() => setAttachHover(true)}
      onMouseLeave={() => setAttachHover(false)}
    >
      <ButtonTooltip visible={attachHover} text={uploadImageTooltipText} />
      <button
        onClick={() => {
          if (atImageLimit) return
          if (variant === 'mobile') {
            setShowMobileUploadMenu((open) => !open)
            return
          }
          fileInputRef.current?.click()
        }}
        className={attachButtonClass}
        aria-label={uploadImageTooltipText}
      >
        {variant === 'mobile' ? (
          <svg
            className={`w-5 h-5 transition-transform duration-200 ${showMobileUploadMenu ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        ) : (
          <AttachIcon />
        )}
      </button>

      {variant === 'mobile' && showMobileUploadMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowMobileUploadMenu(false)}
          />
          <div className="absolute bottom-full left-0 mb-2 w-32 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <button
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
              onClick={() => {
                setShowMobileUploadMenu(false)
                cameraInputRef.current?.click()
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              拍照
            </button>
            <button
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
              onClick={() => {
                setShowMobileUploadMenu(false)
                fileInputRef.current?.click()
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              上传图片
            </button>
          </div>
        </>
      )}
    </div>
  )

  const submitButton = (
    <div
      className={`relative ${variant === 'mobile' ? 'flex-1' : ''}`}
      onMouseEnter={() => setSubmitHover(true)}
      onMouseLeave={() => setSubmitHover(false)}
    >
      <ButtonTooltip visible={showSubmitTooltip} text={submitTooltipText} />
      <button
        onClick={handleSubmitClick}
        disabled={submitDisabled}
        aria-label={submitButtonAriaLabel}
        className={submitButtonClass}
      >
        {activeAgentIsRunning ? (
          <StopIcon className={variant === 'mobile' ? 'w-4 h-4' : undefined} />
        ) : (
          <SubmitIcon className={variant === 'mobile' ? 'w-4 h-4' : undefined} />
        )}
        {variant === 'mobile' && (activeAgentIsRunning ? '停止生成' : maskDraft ? '遮罩编辑' : '生成图像')}
      </button>
    </div>
  )

  const useSplit = canPerImageSplit && hasSubmitApiConfig && !activeAgentIsRunning
  const splitDisabled = !canSubmit
  const splitPrimaryLabel = activeMultiImageMode === 'merge'
    ? `合成 ${mergeOutputCount} 张`
    : `生成 ${perImageOutputCount} 张`

  const modeMenu = showModeMenu && (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setShowModeMenu(false)} />
      <div className="absolute bottom-full right-0 mb-2 w-48 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
        {([
          { mode: 'each' as const, label: '每张各生成', count: perImageOutputCount },
          { mode: 'merge' as const, label: '合成一张', count: mergeOutputCount },
        ]).map((item) => (
          <button
            key={item.mode}
            onClick={() => { setShowModeMenu(false); onSelectMode?.(item.mode) }}
            className="w-full px-3 py-2.5 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center justify-between gap-3 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <CheckIcon className={`w-3.5 h-3.5 shrink-0 ${activeMultiImageMode === item.mode ? 'opacity-100 text-blue-500' : 'opacity-0'}`} />
              {item.label}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">{item.count} 张</span>
          </button>
        ))}
      </div>
    </>
  )

  const splitSubmitButton = (
    <div className={`relative flex ${variant === 'mobile' ? 'flex-1' : ''}`}>
      <button
        onClick={handleSubmitClick}
        disabled={splitDisabled}
        aria-label={splitPrimaryLabel}
        className={`${variant === 'mobile' ? 'flex-1 justify-center' : ''} flex items-center gap-1.5 pl-3 pr-2.5 py-2.5 rounded-l-xl text-sm font-medium transition-all shadow-sm bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <SubmitIcon className="w-4 h-4" />
        {splitPrimaryLabel}
      </button>
      <button
        onClick={() => { if (!splitDisabled) setShowModeMenu((v) => !v) }}
        disabled={splitDisabled}
        aria-label="选择发送模式"
        className="px-1.5 py-2.5 rounded-r-xl transition-all shadow-sm bg-blue-500 text-white hover:bg-blue-600 border-l border-white/25 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <CaretIcon className={`w-4 h-4 transition-transform duration-200 ${showModeMenu ? 'rotate-180' : ''}`} />
      </button>
      {modeMenu}
    </div>
  )

  const activeSubmitButton = useSplit ? splitSubmitButton : submitButton

  if (variant === 'desktop') {
    return (
      <div className="flex gap-2 flex-shrink-0 mb-0.5">
        {attachButton}
        {activeSubmitButton}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {attachButton}
      {activeSubmitButton}
    </div>
  )
}

export function InputBarFileInputs({
  fileInputRef,
  cameraInputRef,
  onFileUpload,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>
  cameraInputRef: RefObject<HTMLInputElement | null>
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onFileUpload}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFileUpload}
      />
    </>
  )
}
