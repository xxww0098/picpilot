import { useEffect, useRef, useState } from 'react'
import type { AdminReverseAuthAccount } from '../../lib/server/adminApi'
import ModalShell from '../ModalShell'

interface ReverseAuthEditModalProps {
  account: AdminReverseAuthAccount
  rawJson: string
  saving: boolean
  onClose: () => void
  onSave: (rawJson: string) => void
}

export default function ReverseAuthEditModal({ account, rawJson, saving, onClose, onSave }: ReverseAuthEditModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(rawJson)
  const [error, setError] = useState('')

  useEffect(() => {
    setValue(formatJSONForEdit(rawJson))
    setError('')
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [rawJson])

  function validate(raw: string): string | null {
    const trimmed = raw.trim()
    if (!trimmed) return '请填写账号 JSON。'
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return 'JSON 格式无效。'
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '账号 JSON 必须是对象。'
    }
    const token = (parsed as Record<string, unknown>).access_token
    if (typeof token !== 'string' || token.trim() === '') {
      return 'JSON 中必须包含 access_token。'
    }
    return null
  }

  function handleFormat() {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2))
      setError('')
    } catch {
      setError('JSON 格式无效，无法格式化。')
    }
  }

  function handleSave() {
    const validationError = validate(value)
    if (validationError) {
      setError(validationError)
      return
    }
    onSave(value.trim())
  }

  return (
    <ModalShell
      portal
      onClose={saving ? undefined : onClose}
      zIndexClass="z-[110]"
      paddingClass="p-4"
      backdropVariant="confirm"
      panelRef={panelRef}
      scrollRef={panelRef}
      panelClassName="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl shadow-black/15 dark:shadow-black/50"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[hsl(var(--border))] px-5 py-4">
        <div>
          <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">编辑逆向账号 JSON</h3>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{account.name}</p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={onClose}
          className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
          保存后会替换服务器数据库中的账号 JSON，并清空该账号旧的额度、登录态和路由统计。请确认只粘贴可信来源的 OAuth JSON。
        </p>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError('')
          }}
          spellCheck={false}
          className={`min-h-[22rem] w-full resize-y rounded-lg border bg-[hsl(var(--background))] px-3 py-2 font-mono text-xs leading-relaxed text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.15)] ${
            error ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/15' : 'border-[hsl(var(--border))]'
          }`}
        />
        {error && <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--border))] px-5 py-4">
        <button
          type="button"
          disabled={saving}
          onClick={handleFormat}
          className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          格式化 JSON
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="rounded border border-[hsl(var(--border))] px-4 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="rounded bg-[hsl(var(--primary))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存账号'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

function formatJSONForEdit(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
