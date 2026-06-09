import { useMemo } from 'react'
import { useStore } from '../store'
import { DEFAULT_VIDEO_DURATION_SECONDS, normalizeVideoDurationSeconds } from '../lib/apiProfiles'
import QueueBanner from './QueueBanner'
import SearchBar from './SearchBar'
import TaskGrid from './TaskGrid'

const VIDEO_STARTERS = [
  {
    id: 'product-spin',
    title: '商品 360 展示',
    prompt: '生成一段电商商品短视频：主体居中，镜头缓慢环绕，干净背景，光线柔和，突出材质和轮廓，适合商品详情页首屏。',
  },
  {
    id: 'detail-motion',
    title: '细节卖点动效',
    prompt: '生成一段商品细节卖点视频：从整体推进到关键细节，镜头稳定，突出质感、功能和使用场景，画面干净，不加入多余文字。',
  },
  {
    id: 'lifestyle-scene',
    title: '生活方式场景',
    prompt: '生成一段生活方式商品视频：真实室内场景，人物不抢主体，镜头从环境过渡到商品，节奏自然，适合社媒种草。',
  },
] as const

function VideoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="14" height="14" rx="2" strokeWidth={2} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9l4-2.5v11L17 15" />
    </svg>
  )
}

export default function VideoWorkspace() {
  const tasks = useStore((s) => s.tasks)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setPrompt = useStore((s) => s.setPrompt)

  const videoTasks = useMemo(() => tasks.filter((task) => task.mediaType === 'video'), [tasks])
  const runningCount = videoTasks.filter((task) => task.status === 'running').length
  const doneCount = videoTasks.filter((task) => task.status === 'done').length
  const errorCount = videoTasks.filter((task) => task.status === 'error').length
  const durationSeconds = normalizeVideoDurationSeconds(settings.videoDurationSeconds, DEFAULT_VIDEO_DURATION_SECONDS)

  const applyStarter = (prompt: string) => {
    setPrompt(prompt)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-input-prompt-editor]')?.focus()
    })
  }

  return (
    <main data-video-workspace data-drag-select-surface className="pb-48">
      <div className="safe-area-x mx-auto max-w-7xl">
        <QueueBanner />

        <section className="mt-4 border-b border-gray-200/70 pb-4 dark:border-white/[0.08] sm:mt-6 sm:pb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="mb-3 inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                <VideoIcon className="h-4 w-4" />
                视频工作台
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">把商品图变成可复用短视频</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
                适合商品环绕、细节推进和生活方式镜头。视频任务独立于图片画廊，完成后可在卡片中预览和下载。
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:min-w-[24rem]">
              <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-xs text-gray-400 dark:text-gray-500">生成中</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-gray-950 dark:text-white">{runningCount}</div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-xs text-gray-400 dark:text-gray-500">已完成</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-gray-950 dark:text-white">{doneCount}</div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-xs text-gray-400 dark:text-gray-500">失败</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-gray-950 dark:text-white">{errorCount}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {VIDEO_STARTERS.map((starter) => (
                <button
                  key={starter.id}
                  type="button"
                  onClick={() => applyStarter(starter.prompt)}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-emerald-200 hover:bg-emerald-50/60 hover:text-emerald-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:border-emerald-400/30 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-200"
                >
                  {starter.title}
                </button>
              ))}
            </div>

            <div className="inline-flex w-fit items-center gap-1 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/[0.08] dark:bg-white/[0.03]">
              {[6, 10, 15].map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  onClick={() => setSettings({ videoDurationSeconds: seconds })}
                  className={`h-8 rounded-lg px-3 text-sm font-medium transition-colors ${
                    durationSeconds === seconds
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200'
                      : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-white'
                  }`}
                >
                  {seconds} 秒
                </button>
              ))}
            </div>
          </div>
        </section>

        <SearchBar />
        <TaskGrid />
      </div>
    </main>
  )
}
