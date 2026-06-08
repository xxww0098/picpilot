import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { collectAgentRoundOutputImageSlots } from '../../lib/agentImageReferences'
import {
  getContentEditableCursor,
  getContentEditablePlainText,
  getContentEditableSelection,
  getMentionTagHtml,
  setContentEditableCursor,
  setContentEditableSelection,
  syncMentionTagSelection,
} from '../../lib/contentEditableMentions'
import {
  getAtImageQuery,
  getImageMentionLabel,
  getPromptIndexFromVisibleIndex,
  getPromptMentionParts,
  getSelectedImageMentionLabel,
  imageMentionMatches,
  insertImageMentionAtVisibleRange,
  insertTextMentionAtVisibleRange,
  isCursorInSelectedImageMention,
  stripImageMentionMarkers,
} from '../../lib/promptImageMentions'
import { getActiveAgentRounds } from '../../store'
import type { AgentConversation, InputImage, TaskRecord } from '../../types'
import { agentImageMentionMatches, type AtImageOption } from './atImageOptions'

const PROMPT_PLACEHOLDER = '描述你想生成的图片，可输入 @ 来指定参考图...'

export type UseInputBarPromptEditorOptions = {
  prompt: string
  setPrompt: (prompt: string) => void
  inputImages: InputImage[]
  imagesRef: RefObject<HTMLDivElement | null>
  tasks: TaskRecord[]
  activeAgentConversation: AgentConversation | null
  enterSubmit: boolean
  canSubmit: boolean
  onSubmit: () => void
  maskDraft: unknown
  maskPreviewUrl: string
  promptPlaceholder?: string
}

export function useInputBarPromptEditor({
  prompt,
  setPrompt,
  inputImages,
  imagesRef,
  tasks,
  activeAgentConversation,
  enterSubmit,
  canSubmit,
  onSubmit,
  maskDraft,
  maskPreviewUrl,
  promptPlaceholder = PROMPT_PLACEHOLDER,
}: UseInputBarPromptEditorOptions) {
  const textareaRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(42)
  const isUserInputRef = useRef(false)

  const [isSingleLine, setIsSingleLine] = useState(true)
  const [cursorPos, setCursorPos] = useState(0)
  const [menuLeft, setMenuLeft] = useState(0)
  const [atImageMenuIndex, setAtImageMenuIndex] = useState(0)
  const [atImageMenuDismissed, setAtImageMenuDismissed] = useState(false)

  const syncPromptFromContentEditable = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    isUserInputRef.current = true
    const range = getContentEditableSelection(el)
    setCursorPos(range.start)
    syncMentionTagSelection(el)
    setPrompt(getContentEditablePlainText(el))
  }, [setPrompt])

  const agentOutputImageOptions = useMemo<AtImageOption[]>(() => {
    if (!activeAgentConversation) return []
    return getActiveAgentRounds(activeAgentConversation).flatMap((round) =>
      collectAgentRoundOutputImageSlots(round, tasks).flatMap((imageId, imageIndex) => {
        if (!imageId) return []
        const label = `@第${round.index}轮图${imageIndex + 1}`
        return {
          type: 'agent-output' as const,
          key: `agent-output:${round.id}:${imageIndex}:${imageId}`,
          label,
          imageId,
          insertText: label,
        }
      }),
    )
  }, [activeAgentConversation, tasks])

  const atImageSourceCount = inputImages.length + agentOutputImageOptions.length
  const visiblePrompt = stripImageMentionMarkers(prompt)
  const atImageQuery = isCursorInSelectedImageMention(prompt, cursorPos)
    ? null
    : getAtImageQuery(visiblePrompt, cursorPos, { length: atImageSourceCount })
  const atImageOptions = atImageQuery
    ? [
        ...inputImages
          .map((img, index) => ({
            type: 'input' as const,
            key: `input:${img.id}:${index}`,
            label: getImageMentionLabel(index),
            imageId: img.id,
            dataUrl: img.dataUrl,
            imageIndex: index,
          } satisfies AtImageOption))
          .filter((option) => imageMentionMatches(atImageQuery.query, option.imageIndex)),
        ...agentOutputImageOptions.filter((option) => agentImageMentionMatches(atImageQuery.query, option.label)),
      ]
    : []
  const showAtImageMenu = !atImageMenuDismissed && atImageOptions.length > 0

  const selectAtImageOption = useCallback((option: AtImageOption) => {
    const el = textareaRef.current
    const cursor = el ? getContentEditableCursor(el) : prompt.length
    const query = getAtImageQuery(stripImageMentionMarkers(prompt), cursor, { length: atImageSourceCount })
    setAtImageMenuDismissed(true)
    setAtImageMenuIndex(0)
    if (!query) return

    const mentionText = option.type === 'input' ? getImageMentionLabel(option.imageIndex) : option.insertText
    const nextCursor = query.start + mentionText.length
    if (el) {
      el.focus()
      setContentEditableSelection(el, query.start, cursor)
      if (document.execCommand('insertHTML', false, getMentionTagHtml(mentionText))) {
        setContentEditableCursor(el, nextCursor)
        syncPromptFromContentEditable()
        return
      }
    }

    const next = option.type === 'input'
      ? insertImageMentionAtVisibleRange(prompt, query.start, cursor, option.imageIndex)
      : insertTextMentionAtVisibleRange(prompt, query.start, cursor, option.insertText)
    isUserInputRef.current = false
    setPrompt(next.prompt)
    window.setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        setContentEditableCursor(textareaRef.current, next.cursor)
      }
    }, 0)
  }, [atImageSourceCount, prompt, setPrompt, syncPromptFromContentEditable])

  const insertPromptTextAtSelection = useCallback((text: string) => {
    const el = textareaRef.current
    if (el) {
      el.focus()
      if (document.execCommand('insertText', false, text)) {
        syncPromptFromContentEditable()
        return
      }
    }

    const selection = el ? getContentEditableSelection(el) : { start: prompt.length, end: prompt.length }
    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end)
    const nextPrompt = `${prompt.slice(0, promptStart)}${text}${prompt.slice(promptEnd)}`
    const nextCursor = selection.start + text.length
    isUserInputRef.current = false
    setPrompt(nextPrompt)
    window.setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        setContentEditableCursor(textareaRef.current, nextCursor)
      }
    }, 0)
  }, [prompt, setPrompt, syncPromptFromContentEditable])

  const handleClearPrompt = useCallback(() => {
    isUserInputRef.current = false
    setPrompt('')
    if (textareaRef.current) {
      textareaRef.current.innerHTML = ''
      textareaRef.current.focus()
    }
  }, [setPrompt])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (showAtImageMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtImageMenuIndex((idx) => (idx + 1) % atImageOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtImageMenuIndex((idx) => (idx - 1 + atImageOptions.length) % atImageOptions.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        selectAtImageOption(atImageOptions[atImageMenuIndex] ?? atImageOptions[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtImageMenuIndex(0)
        textareaRef.current?.blur()
        return
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const isModifier = e.ctrlKey || e.metaKey

      if (enterSubmit) {
        if (e.shiftKey) {
          insertPromptTextAtSelection('\n')
        } else if (!isModifier) {
          if (canSubmit) onSubmit()
        }
      } else if (isModifier) {
        if (canSubmit) onSubmit()
      } else {
        insertPromptTextAtSelection('\n')
      }
    }
  }, [
    atImageMenuIndex,
    atImageOptions,
    canSubmit,
    enterSubmit,
    insertPromptTextAtSelection,
    onSubmit,
    selectAtImageOption,
    showAtImageMenu,
  ])

  const handlePromptPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    if (Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'))) return

    e.preventDefault()
    insertPromptTextAtSelection(text.replace(/\r\n?/g, '\n'))
  }, [insertPromptTextAtSelection])

  const handlePromptCopy = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = textareaRef.current
    if (!el) return

    const selection = getContentEditableSelection(el)
    if (selection.start === selection.end) return

    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end)
    const text = stripImageMentionMarkers(prompt.slice(promptStart, promptEnd))
    const copyText = /^\s*@图\d+\s*$/.test(text) ? text.trim() : text

    e.preventDefault()
    e.clipboardData.setData('text/plain', copyText)
  }, [prompt])

  const handlePromptInput = useCallback((el: HTMLDivElement) => {
    isUserInputRef.current = true
    const range = getContentEditableSelection(el)
    setCursorPos(range.start)
    syncMentionTagSelection(el)
    setPrompt(getContentEditablePlainText(el))
    setAtImageMenuIndex(0)
    setAtImageMenuDismissed(false)
  }, [setPrompt])

  const handlePromptSelect = useCallback((el: HTMLDivElement) => {
    const range = getContentEditableSelection(el)
    setCursorPos(range.start)
    syncMentionTagSelection(el)
    setAtImageMenuIndex(0)
    setAtImageMenuDismissed(false)
  }, [])

  const handlePromptClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = textareaRef.current
    if (!el) return
    const target = e.target as HTMLElement
    if (target.classList.contains('mention-tag')) {
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNode(target)
        sel.removeAllRanges()
        sel.addRange(range)
        syncMentionTagSelection(el)
      }
      return
    }
    syncMentionTagSelection(el)
  }, [])

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    const imagesHeight = imagesRef.current?.offsetHeight ?? 0
    const fixedOverhead = imagesHeight + 140
    const maxH = Math.max(window.innerHeight * 0.4 - fixedOverhead, 80)

    el.style.transition = 'none'
    el.style.height = '0'
    el.style.overflowY = 'hidden'
    const scrollH = el.scrollHeight

    const placeholderEl = el.parentElement?.querySelector('.prompt-placeholder')
    const placeholderH = placeholderEl ? placeholderEl.scrollHeight : 0
    const minH = Math.max(42, placeholderH)

    const desired = Math.max(scrollH, minH)
    const targetH = desired > maxH ? maxH : desired

    setIsSingleLine(desired <= minH)

    el.style.height = prevHeightRef.current + 'px'
    void el.offsetHeight

    el.style.transition = 'height 150ms ease, border-color 200ms, box-shadow 200ms'
    el.style.height = targetH + 'px'
    el.style.overflowY = desired > maxH ? 'auto' : 'hidden'

    prevHeightRef.current = targetH
  }, [imagesRef])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (isUserInputRef.current) {
      isUserInputRef.current = false
      return
    }
    const parts = getPromptMentionParts(prompt, inputImages)
    const html = prompt
      ? parts.map((part) =>
          part.type === 'mention'
            ? `<span contenteditable="false" class="mention-tag" data-mention-text="${part.mentionText ?? getSelectedImageMentionLabel(part.imageIndex ?? 0)}">${part.text}</span>`
            : part.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        ).join('')
      : ''
    if (el.innerHTML !== html) {
      el.innerHTML = html
    }
  }, [prompt, inputImages])

  useEffect(() => {
    adjustTextareaHeight()
  }, [prompt, inputImages, adjustTextareaHeight])

  useEffect(() => {
    const handleSelectionChange = () => {
      const el = textareaRef.current
      if (!el) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return

      const domRange = sel.getRangeAt(0)
      try {
        if (!domRange.intersectsNode(el)) {
          syncMentionTagSelection(el)
          return
        }
      } catch {
        return
      }

      const range = getContentEditableSelection(el)
      setCursorPos(range.start)
      syncMentionTagSelection(el)

      const rangeRect = domRange.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      if (rangeRect.width === 0 && rangeRect.height === 0) return
      setMenuLeft(rangeRect.left - elRect.left)
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  useEffect(() => {
    adjustTextareaHeight()
  }, [inputImages.length, Boolean(maskDraft), maskPreviewUrl, adjustTextareaHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustTextareaHeight)
    return () => window.removeEventListener('resize', adjustTextareaHeight)
  }, [adjustTextareaHeight])

  return {
    textareaRef,
    isUserInputRef,
    syncPromptFromContentEditable,
    isSingleLine,
    promptPlaceholder,
    showAtImageMenu,
    atImageOptions,
    atImageMenuIndex,
    menuLeft,
    setAtImageMenuIndex,
    selectAtImageOption,
    handleKeyDown,
    handlePromptPaste,
    handlePromptCopy,
    handleClearPrompt,
    handlePromptInput,
    handlePromptSelect,
    handlePromptClick,
  }
}
