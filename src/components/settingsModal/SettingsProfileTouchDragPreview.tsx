import { createPortal } from 'react-dom'
import { DragHandleIcon } from '../ui/icons'
import type { ProfileTouchDragPreview } from './useProfileDrag'

// 触摸拖拽连接配置时跟手显示的预览卡片（由 SettingsModal 抽出，JSX 原样搬移、渲染等价）。
export default function SettingsProfileTouchDragPreview({
  profileTouchDragPreview,
}: {
  profileTouchDragPreview: ProfileTouchDragPreview
}) {
  return createPortal(
    <div
      className="fixed pointer-events-none z-[110] flex items-center justify-between gap-2 rounded-xl bg-white/95 px-3 py-2 text-xs text-gray-700 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:bg-gray-900/95 dark:text-gray-300 dark:ring-white/10"
      style={{
        left: profileTouchDragPreview.x - profileTouchDragPreview.offsetX,
        top: profileTouchDragPreview.y - profileTouchDragPreview.offsetY,
        width: profileTouchDragPreview.width,
        minHeight: profileTouchDragPreview.height,
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
        <DragHandleIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="min-w-0 truncate">{profileTouchDragPreview.label}</span>
        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
          {profileTouchDragPreview.providerLabel}
        </span>
      </div>
    </div>,
    document.body,
  )
}
