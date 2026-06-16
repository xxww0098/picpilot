import { useStore } from '../../store'

export function openConfirmDialog(options: {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  tone?: 'danger' | 'warning'
  onConfirm: () => void | Promise<void>
}) {
  useStore.getState().setConfirmDialog({
    title: options.title,
    message: options.message,
    tone: options.tone,
    confirmText: options.confirmText,
    cancelText: options.cancelText,
    action: () => void options.onConfirm(),
  })
}

export function openDestructiveConfirm(options: {
  title: string
  message: string
  confirmText?: string
  onConfirm: () => void | Promise<void>
}) {
  openConfirmDialog({
    ...options,
    tone: 'danger',
    confirmText: options.confirmText ?? '确认删除',
  })
}

export function openPromptDialog(options: {
  title: string
  message?: string
  defaultValue?: string
  inputType?: 'text' | 'password' | 'number'
  placeholder?: string
  confirmText?: string
  validate?: (value: string) => string | null
  onConfirm: (value: string) => void | Promise<void>
}) {
  useStore.getState().setPromptDialog({
    title: options.title,
    message: options.message,
    defaultValue: options.defaultValue ?? '',
    inputType: options.inputType ?? 'text',
    placeholder: options.placeholder,
    confirmText: options.confirmText ?? '确认',
    validate: options.validate,
    onConfirm: (value) => void options.onConfirm(value),
  })
}

export function showAppToast(message: string, type: 'error' | 'success' | 'info' = 'info') {
  useStore.getState().showToast(message, type)
}
