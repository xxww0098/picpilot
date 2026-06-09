import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction, TouchEvent as ReactTouchEvent } from 'react'
import type { AgentConversation, AgentPlatformId } from '../../types'
import { EditIcon, SidebarLeftIcon } from '../icons'
import ConversationListItem from './ConversationListItem'
import { groupConversationsByTime } from '../../lib/agentConversationGroups'

interface AgentConversationSidebarProps {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  conversations: AgentConversation[]
  filteredConversations: AgentConversation[]
  activeConversationId: string | null
  conversationSearchQuery: string
  setConversationSearchQuery: Dispatch<SetStateAction<string>>
  conversationActionsId: string | null
  agentEditingConversationId: string | null
  agentGeneratingTitleIds: Record<string, boolean>
  editingConversationTitle: string
  createConversation: (platformId?: AgentPlatformId) => void
  handleConversationPointerDown: (id: string, e: ReactPointerEvent) => void
  clearConversationLongPressTimer: () => void
  handleConversationSelect: (id: string) => void
  setEditingConversationTitle: Dispatch<SetStateAction<string>>
  handleRenameKeyDown: (e: ReactKeyboardEvent) => void
  confirmRenameConversation: () => void
  startRenameConversation: (e: ReactMouseEvent | ReactTouchEvent, id: string, title: string) => void
  handleDeleteConversation: (id: string) => void
}

export default function AgentConversationSidebar({
  sidebarCollapsed,
  setSidebarCollapsed,
  conversations,
  filteredConversations,
  activeConversationId,
  conversationSearchQuery,
  setConversationSearchQuery,
  conversationActionsId,
  agentEditingConversationId,
  agentGeneratingTitleIds,
  editingConversationTitle,
  createConversation,
  handleConversationPointerDown,
  clearConversationLongPressTimer,
  handleConversationSelect,
  setEditingConversationTitle,
  handleRenameKeyDown,
  confirmRenameConversation,
  startRenameConversation,
  handleDeleteConversation,
}: AgentConversationSidebarProps) {
  return (
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-4/5 max-w-[320px] flex-col border-r border-gray-200 bg-white/95 shadow-2xl backdrop-blur transition-transform duration-300 dark:border-white/[0.08] dark:bg-gray-950/95 ${!sidebarCollapsed ? 'translate-x-0' : '-translate-x-full'} lg:sticky lg:top-16 lg:z-auto lg:h-[calc(100vh-5rem)] lg:w-[18rem] lg:max-w-none lg:translate-x-0 lg:rounded-r-2xl lg:border lg:border-l-0 lg:border-[hsl(var(--border))] lg:bg-[hsl(var(--sidebar))] lg:shadow-none lg:backdrop-blur-none`}>
      <div className="pl-[max(1rem,env(safe-area-inset-left))] lg:pl-0 flex h-full min-h-0 w-full flex-col">
        <div className="safe-area-top shrink-0 lg:hidden">
          <div className="flex h-14 items-center justify-between gap-2 px-4">
            <button type="button" onClick={() => setSidebarCollapsed(true)} className="p-2 -ml-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 rounded-lg transition-colors" title="折叠左侧边栏">
              <SidebarLeftIcon className="w-5 h-5" />
            </button>
            <button type="button" onClick={() => createConversation()} className="p-2 -mr-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 rounded-lg transition-colors" title="新对话">
              <EditIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="hidden lg:flex items-center justify-between gap-3 px-3 pb-2 pt-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 dark:text-white">对话</div>
            <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{conversations.length} 个工作记录</div>
          </div>
          <button
            type="button"
            onClick={() => createConversation()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.09] dark:hover:text-white"
            title="新对话"
          >
            <EditIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 pb-3 lg:px-3">
          <input
            type="text"
            value={conversationSearchQuery}
            onChange={(e) => setConversationSearchQuery(e.target.value)}
            placeholder="搜索对话、提示词..."
            className="w-full rounded-xl border border-gray-200 bg-gray-100/80 px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-400 focus:bg-white dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:border-blue-400 dark:focus:bg-white/[0.07]"
          />
        </div>

        <div className="space-y-1 overflow-y-auto flex-1 px-4 pb-4 lg:px-3">
          {filteredConversations.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-gray-400">没有找到匹配的对话</div>
          )}
          {groupConversationsByTime(filteredConversations).map((group) => (
            <div key={group.label}>
              <div className="mt-3 mb-1 px-2 text-xs font-medium text-gray-400 dark:text-gray-500">{group.label}</div>
              {group.items.map((item) => (
                <ConversationListItem
                  key={item.id}
                  item={item}
                  isGeneratingTitle={Boolean(agentGeneratingTitleIds[item.id])}
                  isEditing={agentEditingConversationId === item.id}
                  isActive={item.id === activeConversationId}
                  showActions={conversationActionsId === item.id}
                  editingTitle={editingConversationTitle}
                  onPointerDown={handleConversationPointerDown}
                  onLongPressClear={clearConversationLongPressTimer}
                  onSelect={handleConversationSelect}
                  onEditingTitleChange={setEditingConversationTitle}
                  onRenameKeyDown={handleRenameKeyDown}
                  onConfirmRename={confirmRenameConversation}
                  onStartRename={startRenameConversation}
                  onDelete={handleDeleteConversation}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
