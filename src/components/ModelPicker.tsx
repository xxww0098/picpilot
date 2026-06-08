export type ModelPickerOption = {
  id: string
  label: string
  /** 模型来源，仅用于界面展示（tooltip） */
  provider: string
}

export type ModelPickerProps = {
  model: string
  options: ModelPickerOption[]
  onChange: (model: string) => void
  ariaLabel: string
  className?: string
}

// 通用模型切换开关：在给定 options 间二/多选一。
// 分段控件复用 Header 画廊/Agent 切换的同款样式，放在其左侧并排。
// 图像模型与 Agent 对话模型共用此组件。
export default function ModelPicker({ model, options, onChange, ariaLabel, className }: ModelPickerProps) {
  // 当前若是清单外的自定义模型（用户在设置里手填），补到末尾并保持选中，
  // 让控件忠实反映现状而不是悄悄“纠正”。
  const allOptions = options.some((option) => option.id === model)
    ? options
    : [...options, { id: model, label: model, provider: '自定义' }]

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex max-w-full items-center gap-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100/70 dark:bg-white/[0.04] p-1 ${className ?? ''}`}
    >
      {allOptions.map((option) => {
        const active = option.id === model
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${option.label} · 由 ${option.provider} 提供`}
            onClick={() => { if (!active) onChange(option.id) }}
            className={`min-w-0 whitespace-nowrap px-2.5 py-1.5 rounded-lg text-[13px] sm:text-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
              active
                ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
