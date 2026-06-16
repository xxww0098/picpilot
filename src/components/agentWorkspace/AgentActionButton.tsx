import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import ViewportTooltip from '../ui/ViewportTooltip'

// 带 hover/focus tooltip 的图标按钮（由 AgentWorkspace 抽出，供会话列表项与消息操作栏共用）。
export default function AgentActionButton({
  tooltip,
  className,
  disabled = false,
  onClick,
  onMouseDown,
  children,
}: {
  tooltip: string
  className: string
  disabled?: boolean
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  onMouseDown?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  const [tooltipVisible, setTooltipVisible] = useState(false)

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      onFocus={() => setTooltipVisible(true)}
      onBlur={() => setTooltipVisible(false)}
    >
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={tooltip}
        onClick={onClick}
        onMouseDown={onMouseDown}
      >
        {children}
      </button>
      <ViewportTooltip visible={tooltipVisible} className="whitespace-nowrap">
        {tooltip}
      </ViewportTooltip>
    </span>
  )
}
