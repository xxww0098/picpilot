import { EditIcon, HistoryIcon, PhotoIcon, WrenchIcon } from '../icons'

export default function AgentConversationHeader({
  title,
  activeConversationRunning,
  activeConversationErrorCount,
  activeConversationStatus,
  roundCount,
  imageCount,
  outputTaskCount,
  onCreateConversation,
}: {
  title: string
  activeConversationRunning: boolean
  activeConversationErrorCount: number
  activeConversationStatus: string
  roundCount: number
  imageCount: number
  outputTaskCount: number
  onCreateConversation: () => void
}) {
  return (
    <div className="hidden lg:flex items-center justify-between gap-4 border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.08]">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-gray-950 dark:text-white">{title}</h1>
          <span className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ${
            activeConversationRunning
              ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
              : activeConversationErrorCount > 0
              ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
              : 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'
          }`}>
            {activeConversationStatus}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
          <span className="inline-flex items-center gap-1"><HistoryIcon className="h-3.5 w-3.5" />{roundCount} 轮</span>
          <span className="inline-flex items-center gap-1"><PhotoIcon className="h-3.5 w-3.5" />{imageCount} 张图</span>
          <span className="inline-flex items-center gap-1"><WrenchIcon className="h-3.5 w-3.5" />{outputTaskCount} 个任务</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onCreateConversation}
        className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
      >
        <EditIcon className="h-4 w-4" />
        新对话
      </button>
    </div>
  )
}
