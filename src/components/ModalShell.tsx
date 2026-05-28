import { useRef, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'

export type ModalBackdropVariant = 'default' | 'confirm'

const BACKDROP_CLASSES: Record<ModalBackdropVariant, string> = {
  default: 'bg-black/30 backdrop-blur-sm animate-overlay-in',
  confirm: 'bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in',
}

export type BackdropCloseMode = 'click' | 'mouseup-outside-panel' | 'pointer-down' | 'none'

type ScrollBoundaryRef = RefObject<HTMLElement | null>

interface ModalShellProps {
  open?: boolean
  onClose?: () => void
  closeOnEscape?: boolean
  lockScroll?: boolean
  scrollRef?: ScrollBoundaryRef | ScrollBoundaryRef[]
  portal?: boolean
  zIndexClass?: string
  paddingClass?: string
  backdropVariant?: ModalBackdropVariant
  backdropClassName?: string
  className?: string
  panelClassName?: string
  panelRef?: RefObject<HTMLDivElement | null>
  noDragSelect?: boolean
  backdropCloseMode?: BackdropCloseMode
  stopBackdropClickPropagation?: boolean
  children: ReactNode
}

export default function ModalShell({
  open = true,
  onClose,
  closeOnEscape = true,
  lockScroll = true,
  scrollRef,
  portal = false,
  zIndexClass = 'z-[100]',
  paddingClass = 'p-4',
  backdropVariant = 'default',
  backdropClassName,
  className,
  panelClassName,
  panelRef,
  noDragSelect = true,
  backdropCloseMode,
  stopBackdropClickPropagation = false,
  children,
}: ModalShellProps) {
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const backdropPointerDownRef = useRef(false)
  const resolvedBackdropClose = backdropCloseMode ?? (onClose ? 'click' : 'none')

  useCloseOnEscape(open && closeOnEscape && Boolean(onClose), onClose ?? (() => {}))
  usePreventBackgroundScroll(open && lockScroll, scrollRef)

  if (!open) return null

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resolvedBackdropClose === 'pointer-down') {
      backdropPointerDownRef.current = e.target === e.currentTarget
    }
  }

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (resolvedBackdropClose === 'mouseup-outside-panel') {
      mouseDownTargetRef.current = e.target
    }
  }

  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (stopBackdropClickPropagation) e.stopPropagation()
    if (resolvedBackdropClose === 'pointer-down' && onClose) {
      if (backdropPointerDownRef.current && e.target === e.currentTarget) onClose()
      backdropPointerDownRef.current = false
      return
    }
    if (resolvedBackdropClose === 'click') onClose?.()
  }

  const handleMouseUp = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (resolvedBackdropClose !== 'mouseup-outside-panel' || !onClose) return
    const panel = panelRef?.current
    const mouseDownTarget = mouseDownTargetRef.current
    const mouseUpTarget = e.target
    if (
      panel &&
      mouseDownTarget &&
      !panel.contains(mouseDownTarget as Node) &&
      mouseUpTarget &&
      !panel.contains(mouseUpTarget as Node)
    ) {
      onClose()
    }
    mouseDownTargetRef.current = null
  }

  const content = (
    <div
      data-no-drag-select={noDragSelect ? '' : undefined}
      className={`fixed inset-0 ${zIndexClass} flex items-center justify-center ${paddingClass}${className ? ` ${className}` : ''}`}
      onClick={resolvedBackdropClose === 'click' || resolvedBackdropClose === 'pointer-down' ? handleClick : undefined}
      onPointerDown={resolvedBackdropClose === 'pointer-down' ? handlePointerDown : undefined}
      onMouseDown={resolvedBackdropClose === 'mouseup-outside-panel' ? handleMouseDown : undefined}
      onMouseUp={resolvedBackdropClose === 'mouseup-outside-panel' ? handleMouseUp : undefined}
    >
      <div className={`absolute inset-0 ${backdropClassName ?? BACKDROP_CLASSES[backdropVariant]}`} />
      <div
        ref={panelRef}
        className={`relative z-10${panelClassName ? ` ${panelClassName}` : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )

  return portal ? createPortal(content, document.body) : content
}
