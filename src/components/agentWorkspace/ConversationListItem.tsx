import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type TouchEvent as ReactTouchEvent } from 'react'
import type { AgentConversation } from '../../types'
import { EditIcon, TrashIcon } from '../icons'
import AgentActionButton from './AgentActionButton'

// 侧边栏单条会话项（由 AgentWorkspace 抽出）。纯展示，状态与回调全部由父组件透传，行为等价。
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
  return (
    <div
      data-agent-conversation-item
      className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
      onPointerDown={(e) => onPointerDown(item.id, e)}
      onPointerUp={onLongPressClear}
      onPointerCancel={onLongPressClear}
      onPointerLeave={onLongPressClear}
      onContextMenu={(e) => {
        if (showActions) e.preventDefault()
      }}
    >
      {isEditing ? (
        <div className="min-w-0 flex-1 flex flex-col justify-center h-[38px]">
          <input
            type="text"
            className="flex-1 bg-white dark:bg-black/20 border border-blue-400/50 dark:border-white/20 rounded px-1.5 py-0.5 text-sm outline-none text-gray-900 dark:text-white focus:border-blue-500 dark:focus:border-white/40 shadow-sm min-w-0"
            value={editingTitle}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            onKeyDown={onRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            onBlur={onConfirmRename}
          />
        </div>
      ) : (
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(item.id)}>
          <div className={`truncate ${isActive ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}>{item.title}</div>
          <div className="text-xs text-gray-400">{new Date(item.updatedAt).toLocaleString()}</div>
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
