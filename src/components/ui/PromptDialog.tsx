import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import ModalShell from './ModalShell'
import Button from './Button'
import Input from './Input'

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
      <Input
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
        className={error ? 'border-[hsl(var(--destructive))] focus:border-[hsl(var(--destructive))] focus:ring-[hsl(var(--destructive)/0.2)]' : undefined}
        autoComplete={promptDialog.inputType === 'password' ? 'new-password' : 'off'}
      />
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      <div className={`flex gap-2 ${error ? 'mt-4' : 'mt-6'}`}>
        <Button type="button" variant="outline" className="flex-1 rounded-lg" onClick={handleClose}>
          {cancelText}
        </Button>
        <Button type="button" variant="primary" className="flex-1 rounded-lg" onClick={handleSubmit}>
          {confirmText}
        </Button>
      </div>
    </ModalShell>
  )
}
