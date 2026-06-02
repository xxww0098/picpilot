import { IMAGE_MODELS, isKnownImageModel, type ImageModelOption } from '../lib/imageModels'

export type ModelPickerProps = {
  model: string
  onChange: (model: string) => void
  className?: string
}

// 图像模型切换开关：gpt-image-2 / grok-imagine-image 二选一。
// 分段控件复用 Header 画廊/Agent 切换的同款样式，放在其左侧并排。
// 写入活动 API 配置的 model 字段（与设置里的模型输入框同一处状态）。
export default function ModelPicker({ model, onChange, className }: ModelPickerProps) {
  // 已知模型按清单顺序；当前若是清单外的自定义模型（用户在设置里手填），
  // 补到末尾并保持选中，让控件忠实反映现状而不是悄悄“纠正”。
  const options: ImageModelOption[] = isKnownImageModel(model)
    ? IMAGE_MODELS
    : [...IMAGE_MODELS, { id: model, label: model, provider: '自定义' }]

  return (
    <div
      role="radiogroup"
      aria-label="图像模型"
      className={`inline-flex items-center gap-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100/70 dark:bg-white/[0.04] p-1 ${className ?? ''}`}
    >
      {options.map((option) => {
        const active = option.id === model
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${option.label} · 由 ${option.provider} 提供`}
            onClick={() => { if (!active) onChange(option.id) }}
            className={`px-3 py-1.5 rounded-lg text-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
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
