import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { getImageMentionLabel, insertImageMentionAtVisibleRange } from '../../lib/ui/promptImageMentions'
import { getSafeBoundingClientRect } from '../../lib/ui/domRect'
import {
  getContentEditableCursor,
  getMentionTagHtml,
  setContentEditableCursor,
} from '../../lib/ui/contentEditableMentions'
import type { InputImage, MaskDraft } from '../../types'
import type { AppState } from '../../store'
import ButtonTooltip from './ButtonTooltip'

export type InputBarImageStripProps = {
  imagesRef: RefObject<HTMLDivElement | null>
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskTargetImage: InputImage | null
  referenceImages: InputImage[]
  maskPreviewUrl: string
  isMobile: boolean
  prompt: string
  setPrompt: (prompt: string) => void
  syncPromptFromContentEditable: () => void
  textareaRef: RefObject<HTMLDivElement | null>
  isUserInputRef: RefObject<boolean>
  moveInputImage: (from: number, to: number) => void
  removeInputImage: (index: number) => void
  clearInputImages: () => void
  setMaskEditorImageId: (id: string) => void
  setLightboxImageId: (id: string, ids: string[]) => void
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void
  setConfirmDialog: AppState['setConfirmDialog']
  onEditReferenceImage: (img: InputImage, idx: number, isMaskTarget: boolean) => void
}

export default function InputBarImageStrip({
  imagesRef,
  inputImages,
  maskDraft,
  maskTargetImage,
  referenceImages,
  maskPreviewUrl,
  isMobile,
  prompt,
  setPrompt,
  syncPromptFromContentEditable,
  textareaRef,
  isUserInputRef,
  moveInputImage,
  removeInputImage,
  clearInputImages,
  setMaskEditorImageId,
  setLightboxImageId,
  showToast,
  setConfirmDialog,
  onEditReferenceImage,
}: InputBarImageStripProps) {

  const [imageHintId, setImageHintId] = useState<string | null>(null)
  const [imageDragIndex, setImageDragIndex] = useState<number | null>(null)
  const [imageDragOverIndex, setImageDragOverIndex] = useState<number | null>(null)
  const [touchDragPreview, setTouchDragPreview] = useState<{ src: string; x: number; y: number } | null>(null)
  const imageHintTimerRef = useRef<number | null>(null)
  const imageHintLockedRef = useRef(false)
  const imageHintReleaseRef = useRef<(() => void) | null>(null)
  const imageDragIndexRef = useRef<number | null>(null)
  const imageDragOverIndexRef = useRef<number | null>(null)
  const imageTouchDragRef = useRef({ index: null as number | null, startX: 0, startY: 0, moved: false })
  const imageDragPreviewRef = useRef<HTMLElement | null>(null)
  const suppressImageClickRef = useRef(false)
  const maskConflictNoticeShownRef = useRef(false)

  useEffect(() => {
    if (!touchDragPreview) return
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
    }
  }, [touchDragPreview])
  const clearImageHintTimer = () => {
    if (imageHintTimerRef.current != null) {
      window.clearTimeout(imageHintTimerRef.current)
      imageHintTimerRef.current = null
    }
  }

  const showImageHint = (id: string) => setImageHintId(id)

  const hideImageHint = () => {
    if (imageHintLockedRef.current) return
    setImageHintId(null)
    clearImageHintTimer()
  }

  const hideLockedImageHint = () => {
    imageHintLockedRef.current = false
    imageHintReleaseRef.current?.()
    imageHintReleaseRef.current = null
    setImageHintId(null)
    clearImageHintTimer()
  }

  const showImageHintUntilRelease = (id: string) => {
    if (imageHintLockedRef.current) {
      setImageHintId(id)
      return
    }
    imageHintLockedRef.current = true
    setImageHintId(id)
    const release = () => {
      window.removeEventListener('mouseup', release)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('dragend', release)
      if (imageHintReleaseRef.current === release) {
        imageHintReleaseRef.current = null
        imageHintLockedRef.current = false
        setImageHintId(null)
        clearImageHintTimer()
      }
    }
    imageHintReleaseRef.current = release
    window.addEventListener('mouseup', release)
    window.addEventListener('pointerup', release)
    window.addEventListener('dragend', release)
  }
  const getTouchDropIndex = (touch: React.Touch) => {
    const target = document
      .elementFromPoint(touch.clientX, touch.clientY)
      ?.closest<HTMLElement>('[data-input-image-index]')
    if (!target) return null
    const idx = Number(target.dataset.inputImageIndex)
    if (!Number.isInteger(idx)) return null
    const rect = getSafeBoundingClientRect(target)
    if (!rect) return null
    return touch.clientX < rect.left + rect.width / 2 ? idx : idx + 1
  }

  const normalizeImageDropIndex = (idx: number) => {
    const minIdx = maskTargetImage ? 1 : 0
    return Math.max(minIdx, Math.min(inputImages.length, idx))
  }

  const isBeforeMaskDropArea = (clientX: number) => {
    if (!maskTargetImage) return false
    const maskEl = document.querySelector<HTMLElement>('[data-input-image-index="0"]')
    if (!maskEl) return false
    const rect = getSafeBoundingClientRect(maskEl)
    if (!rect) return false
    return clientX < rect.left + rect.width / 2
  }

  const resetImageDrag = () => {
    setImageDragIndex(null)
    setImageDragOverIndex(null)
    imageDragIndexRef.current = null
    imageDragOverIndexRef.current = null
    imageTouchDragRef.current = { index: null, startX: 0, startY: 0, moved: false }
    setTouchDragPreview(null)
    imageDragPreviewRef.current?.remove()
    imageDragPreviewRef.current = null
    hideImageHint()
  }

  useEffect(() => {
    if (!touchDragPreview) return
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
    }
  }, [touchDragPreview])

  const getDataTransferDragIndex = (e: React.DragEvent) => {
    const value = e.dataTransfer.getData('text/plain')
    const idx = Number(value)
    return Number.isInteger(idx) ? idx : null
  }

  const setImageDragTarget = (idx: number | null, clientX?: number) => {
    const fromIdx = imageDragIndexRef.current
    if (fromIdx !== null && maskTargetImage && (idx === 0 || (clientX != null && isBeforeMaskDropArea(clientX)))) {
      showImageHint(maskTargetImage.id)
      imageDragOverIndexRef.current = null
      setImageDragOverIndex(null)
      return
    }

    if (fromIdx !== null) hideImageHint()
    const normalizedIdx = idx == null ? null : normalizeImageDropIndex(idx)
    const isNoopTarget = fromIdx !== null && normalizedIdx !== null && (normalizedIdx === fromIdx || normalizedIdx === fromIdx + 1)
    const nextIdx = isNoopTarget ? null : normalizedIdx
    imageDragOverIndexRef.current = nextIdx
    setImageDragOverIndex(nextIdx)
  }
  const renderImageThumb = (img: (typeof inputImages)[number], idx: number) => {
    const isMaskTarget = maskDraft?.targetImageId === img.id
    const canEdit = !maskTargetImage || isMaskTarget
    const imageHintText = isMaskTarget ? '遮罩图必须为第一张图' : ''
    const displaySrc = isMaskTarget && maskPreviewUrl ? maskPreviewUrl : img.dataUrl
    const isImageDragging = imageDragIndex === idx
    const isLast = idx === inputImages.length - 1
    const showDropBefore = imageDragOverIndex === idx && imageDragIndex !== idx
    const showDropAfter = imageDragOverIndex === inputImages.length && isLast && imageDragIndex !== idx

    const handleDragStart = (e: React.DragEvent) => {
      if (isMaskTarget) {
        showImageHintUntilRelease(img.id)
        e.preventDefault()
        return
      }
      hideImageHint()
      imageDragIndexRef.current = idx
      setImageDragIndex(idx)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(idx))
      const preview = document.createElement('div')
      preview.style.cssText = 'position:fixed;left:-1000px;top:-1000px;width:52px;height:52px;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.25);'
      const previewImg = document.createElement('img')
      previewImg.src = displaySrc
      previewImg.style.cssText = 'width:52px;height:52px;object-fit:cover;display:block;'
      preview.appendChild(previewImg)
      document.body.appendChild(preview)
      imageDragPreviewRef.current = preview
      e.dataTransfer.setDragImage(preview, 26, 26)
    }

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const fromIdx = imageDragIndexRef.current
      if (fromIdx === null || fromIdx === idx) return
      const rect = getSafeBoundingClientRect(e.currentTarget)
      if (!rect) return
      setImageDragTarget(e.clientX < rect.left + rect.width / 2 ? idx : idx + 1, e.clientX)
    }

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      const fromIdx = imageDragIndexRef.current ?? getDataTransferDragIndex(e)
      const toIdx = imageDragOverIndexRef.current
      if (fromIdx !== null && toIdx !== null) {
        moveInputImage(fromIdx, toIdx)
      }
      resetImageDrag()
    }

    const handleTouchStart = (e: React.TouchEvent) => {
      if (isMaskTarget) {
        const touch = e.touches[0]
        imageTouchDragRef.current = { index: idx, startX: touch.clientX, startY: touch.clientY, moved: false }
        return
      }
      const touch = e.touches[0]
      imageDragIndexRef.current = idx
      imageTouchDragRef.current = { index: idx, startX: touch.clientX, startY: touch.clientY, moved: false }
      setTouchDragPreview(null)
    }

    const handleTouchMove = (e: React.TouchEvent) => {
      const touch = e.touches[0]
      const touchDrag = imageTouchDragRef.current
      if (touchDrag.index === null) return

      if (isMaskTarget) {
        if (Math.abs(touch.clientX - touchDrag.startX) > 6 || Math.abs(touch.clientY - touchDrag.startY) > 6) {
          e.preventDefault()
          showImageHintUntilRelease(img.id)
        }
        return
      }

      touchDrag.moved = true
      clearImageHintTimer()
      setImageHintId(null)
      suppressImageClickRef.current = true
      e.preventDefault()
      setImageDragIndex(touchDrag.index)
      setTouchDragPreview({ src: displaySrc, x: touch.clientX, y: touch.clientY })
      const dropIndex = getTouchDropIndex(touch)
      setImageDragTarget(dropIndex, touch.clientX)
    }

    const handleTouchEnd = (e: React.TouchEvent) => {
      const touchDrag = imageTouchDragRef.current
      clearImageHintTimer()
      if (touchDrag.index !== null && imageDragOverIndexRef.current !== null) {
        e.preventDefault()
        moveInputImage(touchDrag.index, imageDragOverIndexRef.current)
        window.setTimeout(() => {
          suppressImageClickRef.current = false
        }, 0)
      }
      resetImageDrag()
      hideLockedImageHint()
    }

    const handleTouchCancel = () => {
      suppressImageClickRef.current = false
      hideLockedImageHint()
      resetImageDrag()
    }

    return (
      <div
        key={img.id}
        data-input-image-index={idx}
        className={`relative group inline-block h-[52px] w-[52px] shrink-0 self-start transition-opacity ${isImageDragging ? 'opacity-40' : ''}`}
        style={{ touchAction: isMaskTarget ? 'auto' : 'none' }}
        draggable={!isMobile}
        onMouseLeave={hideImageHint}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={resetImageDrag}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          const el = textareaRef.current
          const cursor = el ? getContentEditableCursor(el) : prompt.length
          if (el) {
            el.focus()
            setContentEditableCursor(el, cursor)
            if (document.execCommand('insertHTML', false, getMentionTagHtml(getImageMentionLabel(idx)))) {
              syncPromptFromContentEditable()
              return
            }
          }
          const next = insertImageMentionAtVisibleRange(prompt, cursor, cursor, idx)
          isUserInputRef.current = false
          setPrompt(next.prompt)
          window.setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus()
              setContentEditableCursor(textareaRef.current, next.cursor)
            }
          }, 0)
        }}
      >
        <ButtonTooltip
          visible={imageHintId === img.id && Boolean(imageHintText) && (!isMobile || isMaskTarget)}
          text={imageHintText}
        />
        {showDropBefore && (
          <div className="absolute -left-[5px] top-0 bottom-0 w-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        {showDropAfter && (
          <div className="absolute -right-[5px] top-0 bottom-0 w-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        <div
          className={`relative w-[52px] h-[52px] rounded-xl overflow-hidden shadow-sm cursor-grab active:cursor-grabbing select-none ${
            isMaskTarget
              ? 'border-2 border-blue-500'
              : 'border border-gray-200 dark:border-white/[0.08]'
          }`}
          onClick={() => {
            if (suppressImageClickRef.current) return
            if (isMaskTarget) {
              setMaskEditorImageId(img.id)
              return
            }
            if (maskTargetImage && !maskConflictNoticeShownRef.current) {
              maskConflictNoticeShownRef.current = true
              showToast('只能有一张遮罩图', 'info')
            }
            setLightboxImageId(img.id, inputImages.map((i) => i.id))
          }}
        >
          {displaySrc && (
            <div className="h-full w-full overflow-hidden rounded-xl">
              <img
                src={displaySrc}
                className="w-full h-full object-cover hover:opacity-90 transition-opacity pointer-events-none"
                alt=""
              />
            </div>
          )}
          {isMaskTarget && (
            <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
              MASK
            </span>
          )}
          <span className="absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/55 text-[9px] font-semibold text-white backdrop-blur-sm z-10 pointer-events-none">
            {idx + 1}
          </span>
          {canEdit && (
            <button 
              className="absolute inset-0 w-full h-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer z-20 focus:outline-none border-none"
              onClick={(e) => {
                e.stopPropagation()
                onEditReferenceImage(img, idx, isMaskTarget)
              }}
              title={isMaskTarget ? "编辑遮罩" : "编辑"}
            >
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          )}
        </div>
        {!isMaskTarget && (
          <span
            className="absolute right-0 top-0 flex h-5 w-5 translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-red-500 text-white opacity-0 shadow-md transition-opacity hover:bg-red-600 group-hover:opacity-100 z-30"
            onClick={(e) => {
              e.stopPropagation()
              removeInputImage(idx)
            }}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        )}
      </div>
    )
  }
  const renderClearAllButton = () => (
    <button
      onClick={() =>
        setConfirmDialog({
          title: maskTargetImage ? '清空全部输入图' : '清空参考图',
          message: maskTargetImage
            ? `确定要清空遮罩主图、${referenceImages.length} 张参考图和当前遮罩吗？`
            : `确定要清空全部 ${inputImages.length} 张参考图吗？`,
          action: () => clearInputImages(),
        })
      }
      className="w-[52px] h-[52px] rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] flex flex-col items-center justify-center gap-0.5 text-gray-400 dark:text-gray-500 hover:text-red-500 hover:border-red-300 hover:bg-red-50/50 dark:hover:bg-red-950/30 transition-all cursor-pointer flex-shrink-0"
      title={maskTargetImage ? '清空遮罩主图、参考图和遮罩' : '清空全部参考图'}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      <span className="text-[8px] leading-none">{maskTargetImage ? '清空全部' : '清空'}</span>
    </button>
  )

  return (
    <div ref={imagesRef}>
      <div className="grid grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3 mb-3">
        {inputImages.map((img, idx) => renderImageThumb(img, idx))}
        {renderClearAllButton()}
      </div>
      {touchDragPreview?.src && createPortal(
        <div
          className="fixed z-[140] h-[52px] w-[52px] overflow-hidden rounded-xl shadow-xl pointer-events-none opacity-90"
          style={{ left: touchDragPreview.x, top: touchDragPreview.y, transform: 'translate(-50%, -50%)' }}
        >
          <img src={touchDragPreview.src} className="h-full w-full object-cover" alt="" />
        </div>,
        document.body,
      )}
    </div>
  )
}
