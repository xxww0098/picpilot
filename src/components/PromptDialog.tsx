import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import ModalShell from './ModalShell'

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100'

function getActionButtonClass(tone: 'primary' | 'secondary' = 'primary') {
  if (tone === 'secondary') {
    return 'border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-400 dark:hover:bg-white/[0.06]'
  }
  return 'bg-blue-500 text-white hover:bg-blue-600'
}

export default function PromptDialog() {
  const promptDialog = useStore((s) => s.promptDialog)
  const setPromptDialog = useStore((s) => s.setPromptDialog)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!promptDialog) return
    setValue(promptDialog.defaultValue ?? '')
    setError('')
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [promptDialog])

  const handleClose = () => {
    promptDialog?.onCancel?.()
    setPromptDialog(null)
  }

  if (!promptDialog) return null

  const confirmText = promptDialog.confirmText ?? '确认'
  const cancelText = promptDialog.cancelText ?? '取消'

  const handleSubmit = () => {
    const trimmed = value.trim()
    const validationError = promptDialog.validate?.(promptDialog.inputType === 'number' ? value : trimmed)
    if (validationError) {
      setError(validationError)
      return
    }
    const submitted = promptDialog.inputType === 'number' ? value : trimmed
    if (promptDialog.inputType !== 'number' && !submitted) {
      setError('请输入内容')
      return
    }
    promptDialog.onConfirm(submitted)
    setPromptDialog(null)
  }

  return (
    <ModalShell
      onClose={handleClose}
      zIndexClass="z-[110]"
      backdropVariant="confirm"
      panelClassName="bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-sm w-full p-6 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in"
    >
      <h3 className="mb-2 text-base font-bold text-gray-800 dark:text-gray-100">{promptDialog.title}</h3>
      {promptDialog.message && (
        <p className="mb-4 whitespace-pre-line text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {promptDialog.message}
        </p>
      )}
      <input
        ref={inputRef}
        type={promptDialog.inputType ?? 'text'}
        value={value}
        placeholder={promptDialog.placeholder}
        onChange={(e) => {
          setValue(e.target.value)
          if (error) setError('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleSubmit()
          }
        }}
        className={`${INPUT_CLASS} ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20' : ''}`}
        autoComplete={promptDialog.inputType === 'password' ? 'new-password' : 'off'}
      />
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      <div className={`flex gap-2 ${error ? 'mt-4' : 'mt-6'}`}>
        <button
          type="button"
          onClick={handleClose}
          className={`flex-1 rounded-lg py-2 text-sm transition ${getActionButtonClass('secondary')}`}
        >
          {cancelText}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${getActionButtonClass('primary')}`}
        >
          {confirmText}
        </button>
      </div>
    </ModalShell>
  )
}
