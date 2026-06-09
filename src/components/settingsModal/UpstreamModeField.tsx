import type { UpstreamMode } from '../../types'

const UPSTREAM_MODE_OPTIONS: Array<{
  value: UpstreamMode
  label: string
  description: string
}> = [
  { value: 'server', label: '跟随后端', description: '不发送覆盖请求头，使用管理员配置的默认上游。' },
  { value: 'api', label: 'API', description: '本配置强制走服务端 API_PROXY_URL 通道。' },
  { value: 'reverse', label: '逆向', description: '本配置强制走 ChatGPT reverse 通道。' },
]

export default function UpstreamModeField({
  value,
  onChange,
}: {
  value: UpstreamMode
  onChange: (value: UpstreamMode) => void
}) {
  const active = UPSTREAM_MODE_OPTIONS.find((option) => option.value === value) ?? UPSTREAM_MODE_OPTIONS[0]

  return (
    <section className="rounded-xl border border-blue-200/70 bg-blue-50/45 p-3 dark:border-blue-500/20 dark:bg-blue-500/10">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">上游通道</div>
          <div data-selectable-text className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            针对当前配置切换 API 或逆向；上游地址和凭据仍只保存在服务端。
          </div>
        </div>
        <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-400/20 dark:bg-white/[0.06] dark:text-blue-300">
          当前: {active.label}
        </span>
      </div>
      <div role="group" aria-label="上游通道" className="grid grid-cols-3 gap-1 rounded-xl border border-gray-200/70 bg-white/75 p-1 dark:border-white/[0.08] dark:bg-black/10">
        {UPSTREAM_MODE_OPTIONS.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={`rounded-lg px-2.5 py-2 text-center text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                selected
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p data-selectable-text className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        {active.description}
      </p>
    </section>
  )
}
