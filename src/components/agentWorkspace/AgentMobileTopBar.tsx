import type { TouchEvent as ReactTouchEvent } from 'react'
import { ChevronDownIcon, EditIcon, SidebarLeftIcon } from '../ui/icons'

export default function AgentMobileTopBar({
  visible,
  agentMobileHeaderVisible,
  title,
  onOpenSidebar,
  onShowMobileHeader,
  onEditTitle,
  onCreateConversation,
  onHeaderTouchStart,
  onHeaderTouchMove,
  onHeaderTouchEnd,
}: {
  visible: boolean
  agentMobileHeaderVisible: boolean
  title: string
  onOpenSidebar: () => void
  onShowMobileHeader: () => void
  onEditTitle: () => void
  onCreateConversation: () => void
  onHeaderTouchStart: (e: ReactTouchEvent<HTMLDivElement>) => void
  onHeaderTouchMove: (e: ReactTouchEvent<HTMLDivElement>) => void
  onHeaderTouchEnd: (e: ReactTouchEvent<HTMLDivElement>) => void
}) {
  return (
    <div className={`sticky top-0 z-20 lg:hidden overflow-hidden transition-all duration-300 ease-in-out ${visible ? 'max-h-16 opacity-100 mb-2' : 'max-h-0 opacity-0 mb-0 pointer-events-none'}`}>
      <div
        className="grid h-14 grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-center border-b border-gray-200 bg-white/80 px-2 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/80"
        onTouchStart={onHeaderTouchStart}
        onTouchMove={onHeaderTouchMove}
        onTouchEnd={onHeaderTouchEnd}
      >
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" onClick={onOpenSidebar} className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/[0.04] dark:hover:text-gray-200" title="展开对话列表">
            <SidebarLeftIcon className="w-5 h-5" />
          </button>
          {!agentMobileHeaderVisible && (
            <button
              type="button"
              onClick={onShowMobileHeader}
              className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/[0.04] dark:hover:text-gray-200"
              aria-label="显示主导航"
              title="显示主导航"
            >
              <ChevronDownIcon className="h-5 w-5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onEditTitle}
          className="min-w-0 truncate rounded px-2 text-center text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]"
        >
          {title}
        </button>
        <div className="flex min-w-0 justify-end">
          <button type="button" onClick={onCreateConversation} className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/[0.04] dark:hover:text-gray-200" title="新对话">
            <EditIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  )
}
