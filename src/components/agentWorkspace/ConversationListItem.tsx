import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type TouchEvent as ReactTouchEvent } from 'react'
import type { AgentConversation } from '../../types'
import { EditIcon, TrashIcon } from '../icons'
import AgentActionButton from './AgentActionButton'

function getConversationPreview(item: AgentConversation) {
  const latestUserMessage = [...item.messages].reverse().find((message) => message.role === 'user' && message.content.trim())
  return latestUserMessage?.content.trim().replace(/\s+/g, ' ') ?? ''
}

function getConversationImageCount(item: AgentConversation) {
  return new Set(item.rounds.flatMap((round) => round.outputTaskIds)).size
}

export default function ConversationListItem({
  item,
  isGeneratingTitle,
  isEditing,
  isActive,
  showActions,
  editingTitle,
  onPointerDown,
  onLongPressClear,
  onSelect,
  onEditingTitleChange,
  onRenameKeyDown,
  onConfirmRename,
  onStartRename,
  onDelete,
}: {
  item: AgentConversation
  isGeneratingTitle: boolean
  isEditing: boolean
  isActive: boolean
  showActions: boolean
  editingTitle: string
  onPointerDown: (id: string, e: ReactPointerEvent) => void
  onLongPressClear: () => void
  onSelect: (id: string) => void
  onEditingTitleChange: (text: string) => void
  onRenameKeyDown: (e: ReactKeyboardEvent) => void
  onConfirmRename: () => void
  onStartRename: (e: ReactMouseEvent | ReactTouchEvent, id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const roundCount = item.rounds.length
  const imageCount = getConversationImageCount(item)
  const isRunning = item.rounds.some((round) => round.status === 'running')
  const preview = getConversationPreview(item)
  const meta = isRunning
    ? '生成中'
    : roundCount > 0
    ? `${roundCount} 轮${imageCount > 0 ? ` · ${imageCount} 个图片任务` : ''}`
    : '空对话'

  return (
    <div
      data-agent-conversation-item
      className={`group flex items-center gap-2 rounded-xl px-2.5 py-2.5 transition-colors ${isActive ? 'bg-gray-200/80 dark:bg-white/[0.09]' : 'hover:bg-gray-100 dark:hover:bg-white/[0.05]'}`}
      onPointerDown={(e) => onPointerDown(item.id, e)}
      onPointerUp={onLongPressClear}
      onPointerCancel={onLongPressClear}
      onPointerLeave={onLongPressClear}
      onContextMenu={(e) => {
        if (showActions) e.preventDefault()
      }}
    >
      {isEditing ? (
        <div className="min-w-0 flex-1">
          <input
            type="text"
            className="w-full min-w-0 rounded-lg border border-blue-400/50 bg-white px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-blue-500 dark:border-white/20 dark:bg-black/20 dark:text-white dark:focus:border-white/40"
            value={editingTitle}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            onKeyDown={onRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            onBlur={onConfirmRename}
          />
        </div>
      ) : (
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(item.id)} title={item.title || '新对话'}>
          <span className={`block truncate text-sm ${isActive ? 'font-semibold text-gray-950 dark:text-white' : 'font-medium text-gray-700 dark:text-gray-300'}`}>{item.title || '新对话'}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-gray-400 dark:text-gray-500">
            {isRunning && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
            <span className="shrink-0">{meta}</span>
            {preview && (
              <>
                <span className="shrink-0 text-gray-300 dark:text-gray-600">/</span>
                <span className="truncate">{preview}</span>
              </>
            )}
          </span>
        </button>
      )}
      <div className={`flex shrink-0 items-center gap-1 overflow-hidden transition-all duration-150 ${isEditing ? 'w-6 opacity-100' : `group-hover:w-[4.5rem] group-hover:opacity-100 group-focus-within:w-[4.5rem] group-focus-within:opacity-100 ${showActions ? 'w-[4.5rem] opacity-100' : 'w-0 opacity-0'}`}`}>
        {isEditing ? (
          <AgentActionButton
            tooltip="确认"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onConfirmRename() }}
            className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-green-500 hover:text-green-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </AgentActionButton>
        ) : (
          <>
            <AgentActionButton tooltip="编辑标题" className="p-1.5 text-gray-400 hover:text-gray-700 disabled:text-gray-300 disabled:hover:text-gray-300 disabled:cursor-not-allowed dark:hover:text-gray-200 dark:disabled:text-gray-600 dark:disabled:hover:text-gray-600" onClick={(e) => onStartRename(e, item.id, item.title)} disabled={isGeneratingTitle}>
              <EditIcon className="w-4 h-4" />
            </AgentActionButton>
            <AgentActionButton tooltip="删除" className="p-1.5 text-gray-400 hover:text-red-500" onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}>
              <TrashIcon className="w-4 h-4" />
            </AgentActionButton>
          </>
        )}
      </div>
    </div>
  )
}
