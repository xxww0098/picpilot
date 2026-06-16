import { useEffect, useMemo, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentMessage, AgentPlatformId, AgentRound, TaskRecord } from '../types'
import { deleteAgentRoundFromConversation, editOutputs, getActiveAgentRounds, getAgentBranchLeafId, getAgentSiblingRounds, ensureImageCached, regenerateAgentAssistantMessage, remapAgentRoundMentionsForPathChange, removeMultipleTasks, removeTask, reuseConfig, sendTaskOutputsToGallery, updateTaskInStore, useStore } from '../store'
import { logger, serializeError } from '../lib/shared/logger'
import { getPromptMentionParts } from '../lib/ui/promptImageMentions'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/ui/clipboard'
import { downloadImageIds } from '../lib/imaging/downloadImages'
import { openConfirmDialog, openDestructiveConfirm } from '../lib/ui/dialog'
import TaskCard from './TaskCard'
import MarkdownRenderer from './MarkdownRenderer'
import { TrashIcon, DownloadIcon, EditIcon, ChevronLeftIcon, ChevronRightIcon, FavoriteIcon, CloseIcon, CopyIcon, RefreshIcon, ArrowDownIcon, PhotoIcon } from './icons'
import AgentActionButton from './agentWorkspace/AgentActionButton'
import AgentConversationHeader from './agentWorkspace/AgentConversationHeader'
import AgentConversationSidebar from './agentWorkspace/AgentConversationSidebar'
import AgentAssetPlanPanel from './agentWorkspace/AgentAssetPlanPanel'
import AgentMobilePullIndicator from './agentWorkspace/AgentMobilePullIndicator'
import AgentMobileTopBar from './agentWorkspace/AgentMobileTopBar'
import AgentWorkspaceEmptyState from './agentWorkspace/AgentWorkspaceEmptyState'
import { getAgentAssistantBlocks, getAgentAssistantCopyContent, getRoundStatusLabel, getRoundTasks, getRoundTaskSlots, isAgentRoundInterrupted } from './agentWorkspace/assistantBlocks'
import { getConversationAssetPlanProgress, getConversationGeneratedImageCount, getConversationOutputTaskIds, getConversationSearchText } from './agentWorkspace/conversationMetrics'
import { ChatImageThumb, AgentStreamingCursor, AgentWebSearchInlineStatus, AgentWebSearchStatusLines } from './agentWorkspace/messageParts'
import { getAgentPlatformDefinition } from '../lib/platforms/registry'
const MOBILE_HEADER_PULL_THRESHOLD = 24
const MOBILE_HEADER_PULL_MAX_OFFSET = 48
const MOBILE_HEADER_EDGE_GUARD = 24

function getPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
}

export default function AgentWorkspace() {
  const conversations = useStore((s) => s.agentConversations)
  const conversationsLoaded = useStore((s) => s.agentConversationsLoaded)
  const activeConversationId = useStore((s) => s.activeAgentConversationId)
  const createConversation = useStore((s) => s.createAgentConversation)
  const setActiveConversationId = useStore((s) => s.setActiveAgentConversationId)
  const renameConversation = useStore((s) => s.renameAgentConversation)
  const deleteConversation = useStore((s) => s.deleteAgentConversation)
  const sidebarCollapsed = useStore((s) => s.agentSidebarCollapsed)
  const setSidebarCollapsed = useStore((s) => s.setAgentSidebarCollapsed)
  const agentMobileHeaderVisible = useStore((s) => s.agentMobileHeaderVisible)
  const setAgentMobileHeaderVisible = useStore((s) => s.setAgentMobileHeaderVisible)
  const appMode = useStore((s) => s.appMode)
  const tasks = useStore((s) => s.tasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setPrompt = useStore((s) => s.setPrompt)
  const setInputImages = useStore((s) => s.setInputImages)
  const setMaskDraft = useStore((s) => s.setMaskDraft)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setAppMode = useStore((s) => s.setAppMode)
  const agentScrollToBottomAfterSubmit = useStore((s) => s.settings.agentScrollToBottomAfterSubmit)
  const agentEditingRoundId = useStore((s) => s.agentEditingRoundId)
  const agentEditingConversationId = useStore((s) => s.agentEditingConversationId)
  const setAgentEditingConversationId = useStore((s) => s.setAgentEditingConversationId)
  const setAgentEditingRoundId = useStore((s) => s.setAgentEditingRoundId)
  const setActiveAgentRoundId = useStore((s) => s.setActiveAgentRoundId)
  const setAgentTargetAssetSlotId = useStore((s) => s.setAgentTargetAssetSlotId)
  const setAgentTaskAssetStatus = useStore((s) => s.setAgentTaskAssetStatus)
  const showToast = useStore((s) => s.showToast)
  const agentGeneratingTitleIds = useStore((s) => s.agentGeneratingTitleIds)
  const conversation = conversations.find((item) => item.id === activeConversationId) ?? null
  const [_selectedRoundId, setSelectedRoundId] = useState<string | null>(null)
  const [editingConversationTitle, setEditingConversationTitle] = useState('')

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const [scrollTargetRoundId, setScrollTargetRoundId] = useState<string | null>(null)
  const [pullDownOffset, setPullDownOffset] = useState(0)
  const [mobileTopBarVisible, setMobileTopBarVisible] = useState(true)
  const [conversationSearchQuery, setConversationSearchQuery] = useState('')
  const [conversationActionsId, setConversationActionsId] = useState<string | null>(null)
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true)
  const touchStartY = useRef(-1)
  const conversationLongPressTimer = useRef<number | null>(null)
  const autoScrollStateRef = useRef<{ conversationId: string | null; lastUserMessageSignature: string | null }>({ conversationId: null, lastUserMessageSignature: null })
  const errorCopyPointerDownRef = useRef<{ x: number; y: number } | null>(null)

  const updateIsScrolledToBottom = useCallback(() => {
    const sentinel = bottomSentinelRef.current
    if (appMode !== 'agent' || !sentinel) {
      setIsScrolledToBottom(true)
      return
    }

    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    setIsScrolledToBottom(sentinel.getBoundingClientRect().top <= viewportHeight + 24)
  }, [appMode])

  const scrollToAgentBottom = useCallback(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement
    window.scrollTo({ top: scrollingElement.scrollHeight, behavior: 'smooth' })
  }, [])

  const handleTouchStart = (e: React.TouchEvent) => {
    const touchY = e.touches[0]?.clientY ?? -1
    if (
      appMode !== 'agent' ||
      agentMobileHeaderVisible ||
      getPageScrollTop() > 0 ||
      touchY < MOBILE_HEADER_EDGE_GUARD
    ) {
      touchStartY.current = -1
      setPullDownOffset(0)
      return
    }

    touchStartY.current = touchY
  }

  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }
   
  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current <= 0 || agentMobileHeaderVisible) return

    const diff = e.touches[0].clientY - touchStartY.current
    if (diff <= 0) {
      setPullDownOffset(0)
      return
    }

    if (e.cancelable) e.preventDefault()
    if (diff >= MOBILE_HEADER_PULL_THRESHOLD) {
      setAgentMobileHeaderVisible(true)
      setPullDownOffset(0)
      touchStartY.current = -1
      return
    }

    setPullDownOffset(Math.min(diff, MOBILE_HEADER_PULL_MAX_OFFSET))
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current > 0 && !agentMobileHeaderVisible) {
      const touchEndY = e.changedTouches[0].clientY
      if (touchEndY - touchStartY.current >= MOBILE_HEADER_PULL_THRESHOLD) setAgentMobileHeaderVisible(true)
    }
    setPullDownOffset(0)
    touchStartY.current = -1
  }

  useEffect(() => {
    if (sidebarCollapsed) {
      setAgentEditingConversationId(null)
    }
  }, [sidebarCollapsed, setAgentEditingConversationId])

  useEffect(() => {
    if (appMode !== 'agent') return

    document.documentElement.classList.add('agent-no-pull-refresh')
    return () => document.documentElement.classList.remove('agent-no-pull-refresh')
  }, [appMode])

  useEffect(() => {
    if (!agentMobileHeaderVisible || appMode !== 'agent') return

    const handleInteract = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('header[data-no-drag-select]')) return
      setAgentMobileHeaderVisible(false)
    }

    document.addEventListener('mousedown', handleInteract, { capture: true })
    document.addEventListener('touchstart', handleInteract, { capture: true })

    return () => {
      document.removeEventListener('mousedown', handleInteract, { capture: true })
      document.removeEventListener('touchstart', handleInteract, { capture: true })
    }
  }, [agentMobileHeaderVisible, appMode, setAgentMobileHeaderVisible])

  useEffect(() => {
    if (appMode !== 'agent') return

    setMobileTopBarVisible(true)
    let lastScrollY = window.scrollY
    let ticking = false

    const handleScroll = () => {
      if (ticking) return

      window.requestAnimationFrame(() => {
        const currentScrollY = window.scrollY
        if (currentScrollY < 20) {
          setMobileTopBarVisible(true)
        } else if (currentScrollY > lastScrollY + 10) {
          setMobileTopBarVisible(false)
        } else if (currentScrollY < lastScrollY - 10) {
          setMobileTopBarVisible(true)
        }

        updateIsScrolledToBottom()

        lastScrollY = currentScrollY
        ticking = false
      })
      ticking = true
    }

    const initialFrame = window.requestAnimationFrame(updateIsScrolledToBottom)
    const visualViewport = window.visualViewport
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', updateIsScrolledToBottom)
    visualViewport?.addEventListener('resize', updateIsScrolledToBottom)

    return () => {
      window.cancelAnimationFrame(initialFrame)
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', updateIsScrolledToBottom)
      visualViewport?.removeEventListener('resize', updateIsScrolledToBottom)
    }
  }, [appMode, updateIsScrolledToBottom])

  useEffect(() => {
    if (appMode !== 'agent') return
    if (!conversationsLoaded) return
    
    if (conversations.length === 0) {
      createConversation()
    } else if (!conversation) {
      const latest = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (latest && latest.messages.length === 0) {
        setActiveConversationId(latest.id)
      } else {
        createConversation()
      }
    }
  }, [appMode, conversationsLoaded, conversations, conversation, createConversation, setActiveConversationId])

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  )

  const filteredConversations = useMemo(() => {
    const query = conversationSearchQuery.trim().toLocaleLowerCase()
    if (!query) return sortedConversations
    return sortedConversations.filter((item) => getConversationSearchText(item).includes(query))
  }, [conversationSearchQuery, sortedConversations])

  const activeRounds = useMemo(
    () => conversation ? getActiveAgentRounds(conversation) : [],
    [conversation],
  )

  const activeMessages = useMemo(() => {
    if (!conversation) return []
    const messages: AgentMessage[] = []
    for (const round of activeRounds) {
      const userMessage = conversation.messages.find((message) => message.id === round.userMessageId)
      if (userMessage) messages.push(userMessage)
      const assistantMessage = round.assistantMessageId
        ? conversation.messages.find((message) => message.id === round.assistantMessageId)
        : conversation.messages.find((message) => message.roundId === round.id && message.role === 'assistant')
      if (assistantMessage) messages.push(assistantMessage)
    }
    return messages
  }, [activeRounds, conversation])

  const activeConversationImageCount = useMemo(
    () => getConversationGeneratedImageCount(conversation, tasks),
    [conversation, tasks],
  )
  const activeConversationRunning = Boolean(conversation?.rounds.some((round) => round.status === 'running'))
  const activeConversationErrorCount = conversation?.rounds.filter((round) => round.status === 'error' && !isAgentRoundInterrupted(round)).length ?? 0
  const activeConversationStatus = activeConversationRunning
    ? '生成中'
    : activeConversationErrorCount > 0
    ? `${activeConversationErrorCount} 个失败轮次`
    : activeRounds.length > 0
    ? '就绪'
    : '新对话'
  const activePlatformDefinition = useMemo(() => {
    const platform = getAgentPlatformDefinition(conversation?.platformId)
    return platform?.enabled ? platform : null
  }, [conversation?.platformId])
  const activeAssetPlanProgress = getConversationAssetPlanProgress(conversation, tasks)
  const showEmptyAgentState = !conversation || activeMessages.length === 0

  const handleCreateConversation = useCallback((platformId?: AgentPlatformId) => {
    createConversation(platformId)
  }, [createConversation])

  const handleMobileTitleClick = useCallback(() => {
    setSidebarCollapsed(false)
    if (conversation) setAgentEditingConversationId(conversation.id)
  }, [conversation, setAgentEditingConversationId, setSidebarCollapsed])

  const focusPromptEditor = useCallback(() => {
    const editor = document.querySelector<HTMLElement>('[data-input-prompt-editor]')
    editor?.focus()
  }, [])

  const applyStarterPrompt = useCallback((promptText: string, targetAssetSlotId?: string) => {
    if (!conversation) createConversation()
    setAgentTargetAssetSlotId(targetAssetSlotId ?? null)
    setPrompt(promptText)
    window.requestAnimationFrame(focusPromptEditor)
  }, [conversation, createConversation, focusPromptEditor, setAgentTargetAssetSlotId, setPrompt])

  useEffect(() => {
    const conversationId = conversation?.id ?? null
    const lastMessage = activeMessages[activeMessages.length - 1] ?? null
    const lastUserMessageSignature = lastMessage?.role === 'user'
      ? `${lastMessage.id}:${lastMessage.createdAt}:${lastMessage.content}`
      : null
    const previous = autoScrollStateRef.current
    const shouldScroll = appMode === 'agent' &&
      agentScrollToBottomAfterSubmit &&
      previous.conversationId === conversationId &&
      lastMessage?.role === 'user' &&
      lastUserMessageSignature != null &&
      previous.lastUserMessageSignature !== lastUserMessageSignature

    autoScrollStateRef.current = { conversationId, lastUserMessageSignature }
    if (!shouldScroll) return

    const frame = window.requestAnimationFrame(() => {
      scrollToAgentBottom()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeMessages, agentScrollToBottomAfterSubmit, appMode, conversation?.id, scrollToAgentBottom])

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateIsScrolledToBottom)
    return () => window.cancelAnimationFrame(frame)
  }, [activeMessages, activeRounds, updateIsScrolledToBottom])

  useEffect(() => {
    if (!scrollTargetRoundId) return
    const id = window.requestAnimationFrame(() => {
      messageRefs.current.get(scrollTargetRoundId)?.scrollIntoView({ block: 'center' })
      setScrollTargetRoundId(null)
    })
    return () => window.cancelAnimationFrame(id)
  }, [activeMessages, scrollTargetRoundId])

  const handleSwitchBranch = (round: AgentRound, direction: -1 | 1) => {
    if (!conversation) return
    const siblings = getAgentSiblingRounds(conversation, round)
    if (siblings.length <= 1) return
    const currentIndex = siblings.findIndex((item) => item.id === round.id)
    const nextRound = siblings[(currentIndex + direction + siblings.length) % siblings.length]
    const nextLeafId = getAgentBranchLeafId(conversation, nextRound.id)
    setActiveAgentRoundId(conversation.id, nextLeafId)
    setAgentEditingRoundId(null)
    setScrollTargetRoundId(nextRound.id)
  }

  const handleDeleteConversation = (id: string) => {
    const targetConversation = conversations.find((item) => item.id === id) ?? null
    const roundIds = new Set(targetConversation?.rounds.map((round) => round.id) ?? [])
    const roundTaskIds = targetConversation?.rounds.flatMap((round) => round.outputTaskIds) ?? []
    const relatedTasks = tasks.filter((task) =>
      task.agentConversationId === id || Boolean(task.agentRoundId && roundIds.has(task.agentRoundId)),
    )
    const existingTaskIds = new Set(tasks.map((task) => task.id))
    const relatedTaskIds = Array.from(new Set([...roundTaskIds, ...relatedTasks.map((task) => task.id)]))
      .filter((taskId) => existingTaskIds.has(taskId))
    const relatedTaskIdSet = new Set(relatedTaskIds)
    const generatedImageCount = new Set(
      tasks
        .filter((task) => relatedTaskIdSet.has(task.id))
        .flatMap((task) => task.outputImages || []),
    ).size

    setConfirmDialog({
      title: '删除对话',
      message: '确定要删除这个 Agent 对话吗？',
      checkbox: generatedImageCount > 0
        ? {
            label: `同时删除对话中生成的图片（${generatedImageCount} 张）`,
            tone: 'danger',
          }
        : undefined,
      action: async (deleteGeneratedImages = false) => {
        deleteConversation(id)
        if (deleteGeneratedImages && relatedTaskIds.length > 0) await removeMultipleTasks(relatedTaskIds)
      },
    })
  }

  const startRenameConversation = (e: ReactMouseEvent | React.TouchEvent, id: string, currentTitle: string) => {
    e.stopPropagation()
    if (agentGeneratingTitleIds[id]) {
      showToast('标题生成中，暂不能修改标题', 'info')
      return
    }
    setAgentEditingConversationId(id)
    setEditingConversationTitle(currentTitle)
  }

  const confirmRenameConversation = () => {
    if (agentEditingConversationId && editingConversationTitle.trim() && !agentGeneratingTitleIds[agentEditingConversationId]) {
      renameConversation(agentEditingConversationId, editingConversationTitle.trim())
    }
    setAgentEditingConversationId(null)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      confirmRenameConversation()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAgentEditingConversationId(null)
    }
  }

  // Effect to sync title when editing id is set from outside (e.g. Header)
  useEffect(() => {
    if (agentEditingConversationId) {
      const convo = conversations.find(c => c.id === agentEditingConversationId)
      if (convo) {
        setEditingConversationTitle(convo.title)
      }
    }
  }, [agentEditingConversationId, conversations])

  const clearConversationLongPressTimer = () => {
    if (conversationLongPressTimer.current == null) return
    window.clearTimeout(conversationLongPressTimer.current)
    conversationLongPressTimer.current = null
  }

  const handleConversationPointerDown = (id: string, e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return
    clearConversationLongPressTimer()
    conversationLongPressTimer.current = window.setTimeout(() => {
      setConversationActionsId(id)
      conversationLongPressTimer.current = null
    }, 450)
  }

  const handleConversationSelect = (id: string) => {
    setActiveConversationId(id)
    if (conversationActionsId && conversationActionsId !== id) setConversationActionsId(null)
  }

  useEffect(() => {
    if (!conversationActionsId) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-agent-conversation-item]')) return
      setConversationActionsId(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', handlePointerDown, { capture: true })
  }, [conversationActionsId])

  const handleDeleteMessage = (message: AgentMessage, round: AgentRound) => {
    const isUserMessage = message.role === 'user'
    openDestructiveConfirm({
      title: isUserMessage ? '删除轮次' : '删除消息',
      message: isUserMessage
        ? '确定要删除这轮记录吗？这会删除这条消息和它的输出，后续消息会被保留。'
        : '确定要删除这条消息吗？关联的图片任务不会从画廊中删除。',
      confirmText: isUserMessage ? '删除轮次' : '删除消息',
      onConfirm: async () => {
        if (isUserMessage) {
          if (round.outputTaskIds.length > 0) await removeMultipleTasks(round.outputTaskIds)

          useStore.setState((state) => {
            const targetConversationId = conversation?.id
            let oldActivePath: AgentRound[] = []
            let newActivePath: AgentRound[] = []
            const agentConversations = state.agentConversations.map((item) => {
              if (item.id !== targetConversationId) return item
              oldActivePath = getActiveAgentRounds(item)
              const nextConversation = deleteAgentRoundFromConversation(item, round.id)
              newActivePath = getActiveAgentRounds(nextConversation)
              return nextConversation
            })
            const draft = targetConversationId ? state.agentInputDrafts[targetConversationId] : null
            const remappedDraft = draft
              ? { ...draft, prompt: remapAgentRoundMentionsForPathChange(draft.prompt, oldActivePath, newActivePath) }
              : null
            const agentInputDrafts = targetConversationId && remappedDraft
              ? { ...state.agentInputDrafts, [targetConversationId]: remappedDraft }
              : state.agentInputDrafts
            const shouldRemapVisibleInput = targetConversationId && state.activeAgentConversationId === targetConversationId && state.appMode === 'agent'
            return {
              agentConversations,
              agentInputDrafts,
              ...(shouldRemapVisibleInput ? { prompt: remapAgentRoundMentionsForPathChange(state.prompt, oldActivePath, newActivePath) } : {}),
              agentEditingRoundId: state.agentEditingRoundId === round.id ? null : state.agentEditingRoundId,
            }
          })
          return
        }

        useStore.setState((state) => ({
          agentConversations: state.agentConversations.map((item) =>
            item.id === conversation?.id
              ? {
                  ...item,
                  updatedAt: Date.now(),
                  rounds: item.rounds.map((candidate) =>
                    candidate.id === round.id && candidate.assistantMessageId === message.id
                      ? { ...candidate, assistantMessageId: undefined }
                      : candidate,
                  ),
                  messages: item.messages.filter((candidate) => candidate.id !== message.id),
                }
              : item,
          ),
          agentEditingRoundId: state.agentEditingRoundId,
        }))
      },
    })
  }

  const handleReuse = (task: TaskRecord) => {
    openConfirmDialog({
      title: '切换到画廊模式？',
      message: '复用参数会应用到画廊输入区。切换到画廊模式后，当前 Agent 对话仍会保留。',
      confirmText: '切换并复用',
      cancelText: '取消',
      onConfirm: () => {
        setAppMode('gallery')
        void reuseConfig(task)
      },
    })
  }

  const handleEditRoundMessage = async (round: AgentRound, content: string) => {
    setAgentEditingRoundId(round.id)
    setAgentTargetAssetSlotId(round.targetAssetSlotId ?? null)
    clearMaskDraft()

    const inputImages = await Promise.all(
      round.inputImageIds.map(async (id) => ({
        id,
        dataUrl: await ensureImageCached(id) || '',
      })),
    )
    setInputImages(inputImages)
    const maskTargetImageId = round.maskTargetImageId ?? (round.maskImageId ? round.inputImageIds[0] : null)
    if (maskTargetImageId && round.maskImageId && inputImages.some((img) => img.id === maskTargetImageId)) {
      const maskDataUrl = await ensureImageCached(round.maskImageId)
      if (maskDataUrl) {
        setMaskDraft({
          targetImageId: maskTargetImageId,
          maskDataUrl,
          updatedAt: Date.now(),
        })
      }
    }
    setPrompt(content)
  }

  const handleCopyMessage = async (content: string, successMessage = '提示词已复制', failureMessage = '复制提示词失败') => {
    try {
      await copyTextToClipboard(content)
      showToast(successMessage, 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(failureMessage, err), 'error')
    }
  }

  const handleErrorCopyPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    errorCopyPointerDownRef.current = { x: e.clientX, y: e.clientY }
  }

  const handleErrorCopyClick = (e: ReactMouseEvent<HTMLDivElement>, content: string) => {
    e.stopPropagation()

    const pointerDown = errorCopyPointerDownRef.current
    errorCopyPointerDownRef.current = null
    if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 4) return

    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      const target = e.currentTarget
      if ((selection.anchorNode && target.contains(selection.anchorNode)) || (selection.focusNode && target.contains(selection.focusNode))) return
    }

    void handleCopyMessage(content, '完整报错已复制', '复制完整报错失败')
  }

  return (
    <main 
      data-agent-workspace 
      className="relative flex min-h-[calc(100vh-100px)] w-full flex-col overflow-visible px-0 transition-all duration-300 lg:flex-row lg:gap-3"
    >
      <AgentMobilePullIndicator
        pullDownOffset={pullDownOffset}
        hidden={agentMobileHeaderVisible}
        maxOffset={MOBILE_HEADER_PULL_MAX_OFFSET}
      />

      {/* Mobile Left Sidebar Overlay Backdrop */}
      {!sidebarCollapsed && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarCollapsed(true)} />
      )}
      
      <AgentConversationSidebar
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        conversations={conversations}
        filteredConversations={filteredConversations}
        activeConversationId={activeConversationId}
        conversationSearchQuery={conversationSearchQuery}
        setConversationSearchQuery={setConversationSearchQuery}
        conversationActionsId={conversationActionsId}
        agentEditingConversationId={agentEditingConversationId}
        agentGeneratingTitleIds={agentGeneratingTitleIds}
        editingConversationTitle={editingConversationTitle}
        createConversation={handleCreateConversation}
        handleConversationPointerDown={handleConversationPointerDown}
        clearConversationLongPressTimer={clearConversationLongPressTimer}
        handleConversationSelect={handleConversationSelect}
        setEditingConversationTitle={setEditingConversationTitle}
        handleRenameKeyDown={handleRenameKeyDown}
        confirmRenameConversation={confirmRenameConversation}
        startRenameConversation={startRenameConversation}
        handleDeleteConversation={handleDeleteConversation}
      />

      <section className="min-w-0 flex-1 flex flex-col relative">
        <AgentMobileTopBar
          visible={mobileTopBarVisible}
          agentMobileHeaderVisible={agentMobileHeaderVisible}
          title={conversation?.title || 'Agent'}
          onOpenSidebar={() => setSidebarCollapsed(false)}
          onShowMobileHeader={() => setAgentMobileHeaderVisible(true)}
          onEditTitle={handleMobileTitleClick}
          onCreateConversation={() => handleCreateConversation()}
          onHeaderTouchStart={handleHeaderTouchStart}
          onHeaderTouchMove={handleTouchMove}
          onHeaderTouchEnd={handleTouchEnd}
        />

        {conversation && (
          <AgentConversationHeader
            title={conversation.title || 'Agent'}
            platformId={conversation.platformId}
            activeConversationRunning={activeConversationRunning}
            activeConversationErrorCount={activeConversationErrorCount}
            activeConversationStatus={activeConversationStatus}
            roundCount={activeRounds.length}
            imageCount={activeConversationImageCount}
            outputTaskCount={getConversationOutputTaskIds(conversation).length}
            assetPlanProgress={activeAssetPlanProgress}
            onCreateConversation={() => handleCreateConversation()}
          />
        )}

        {conversation && activePlatformDefinition && (
          <AgentAssetPlanPanel
            conversation={conversation}
            tasks={tasks}
            onSetTaskAssetStatus={setAgentTaskAssetStatus}
          />
        )}

        <div 
          ref={scrollContainerRef}
          className="flex-1 space-y-4 overflow-visible pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)] px-1 lg:px-6 lg:pt-6"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {showEmptyAgentState ? (
            <AgentWorkspaceEmptyState
              platformDefinition={activePlatformDefinition}
              onSelectPlatform={handleCreateConversation}
              onApplyPrompt={applyStarterPrompt}
            />
          ) : (
            (() => {
              if (!conversation) return null

              const renderedMessages = activeMessages.map((message) => {
                const round = conversation.rounds.find((item) => item.id === message.roundId)
                const isAssistant = message.role === 'assistant'
                const isStreamingAssistant = isAssistant && round?.status === 'running'
                const isEditing = !isAssistant && round?.id === agentEditingRoundId
                const siblingRounds = !isAssistant && round ? getAgentSiblingRounds(conversation, round) : []
                const siblingIndex = round ? siblingRounds.findIndex((item) => item.id === round.id) : -1
                const hasBranches = siblingRounds.length > 1
                const taskSlotsForRound = isAssistant ? getRoundTaskSlots(round ?? null, tasks) : []
                const tasksForRound = taskSlotsForRound.map((slot) => slot.task).filter(Boolean) as TaskRecord[]
                const favoriteTasksForRound = tasksForRound.filter((task) => (task.outputImages?.length ?? 0) > 0)
                const hasRoundFavoriteTasks = favoriteTasksForRound.length > 0
                const allRoundTasksFavorited = hasRoundFavoriteTasks && favoriteTasksForRound.every((task) => task.isFavorite)
                const assistantBlocks = isAssistant ? getAgentAssistantBlocks(round ?? null, taskSlotsForRound, tasks, Boolean(message.content.trim())) : []
                const inputImagesForRound = (round?.inputImageIds || []).map(id => ({ id, dataUrl: '' }))
                const parts = getPromptMentionParts(message.content, inputImagesForRound)
                const roundStatusLabel = getRoundStatusLabel(round ?? null)
                const roundImageCount = tasksForRound.reduce((count, task) => count + (task.outputImages?.length ?? 0), 0)
                return (
                  <div key={message.id} className={`mb-4 flex w-full ${isAssistant ? 'justify-start' : 'justify-end'}`}>
                    <div
                      ref={(node) => {
                        if (!isAssistant && node) messageRefs.current.set(message.roundId, node)
                        else if (!isAssistant) messageRefs.current.delete(message.roundId)
                      }}
                      className={`group flex max-w-[95%] flex-col ${isAssistant ? 'items-start md:max-w-[88%] lg:max-w-[82%]' : 'items-end md:max-w-[78%] lg:max-w-[68%]'}`}
                    >
                      <article
                        className={`relative flex min-w-[16rem] max-w-full flex-col rounded-2xl border p-4 transition-colors duration-200 sm:p-5 ${
                        isAssistant
                          ? 'rounded-tl-md border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.035] dark:hover:bg-white/[0.05]'
                          : `rounded-tr-md border-gray-200/80 bg-gray-100 dark:border-white/[0.06] dark:bg-[#25282d] ${isEditing ? 'ring-2 ring-blue-500/50 dark:ring-blue-400/50' : ''}`
                      }`}
                      >
                    <div className="mb-3 flex items-center justify-between gap-4 text-sm text-gray-500 dark:text-gray-400">
                      <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedRoundId(message.roundId); }} className="inline-flex min-w-0 items-center gap-2 transition-colors hover:text-gray-800 dark:hover:text-gray-200">
                         <span className={isAssistant ? 'font-semibold text-blue-600 dark:text-blue-400' : 'font-semibold text-gray-700 dark:text-gray-200'}>{isAssistant ? 'PicPilot Agent' : '你'}</span>
                         <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">第 {round?.index ?? '?'} 轮</span>
                         {isAssistant && roundStatusLabel && (
                           <span className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ${
                             round?.status === 'running'
                               ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                               : round?.status === 'error'
                               ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
                               : 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'
                           }`}>{roundStatusLabel}</span>
                         )}
                      </button>
                      {isAssistant && roundImageCount > 0 && (
                        <span className="hidden shrink-0 items-center gap-1 rounded-md bg-gray-100 px-1.5 py-1 text-[11px] font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400 sm:inline-flex">
                          <PhotoIcon className="h-3.5 w-3.5" />
                          {roundImageCount} 张图
                        </span>
                      )}
                    </div>
                    
                    {message.role === 'user' && round && round.inputImageIds.length > 0 && (
                      <div className="flex gap-2 mb-3 overflow-x-auto pb-1" onClick={e => e.stopPropagation()}>
                          {round.inputImageIds.map((imgId, imageIndex) => (
                            <ChatImageThumb
                              key={imgId}
                              imageId={imgId}
                              imageIndex={imageIndex}
                              maskImageId={imgId === (round.maskTargetImageId ?? round.inputImageIds[0]) ? round.maskImageId : null}
                            />
                          ))}
                      </div>
                    )}

                    {round?.status === 'error' && isAssistant && message.content.startsWith('请求失败：') ? (
                      <div
                        data-selectable-text
                        className="-m-2 flex cursor-copy select-text flex-col rounded-xl p-2 transition-colors hover:bg-red-50/60 dark:hover:bg-red-500/5"
                        title="点击复制完整报错"
                        onPointerDown={handleErrorCopyPointerDown}
                        onClick={(e) => handleErrorCopyClick(e, message.content)}
                      >
                        {(() => {
                          const content = message.content.replace(/^请求失败：/, '');
                          const [mainErr, ...hints] = content.split('\n提示：');
                          return (
                            <>
                              <div className="flex items-start gap-2 text-red-500 dark:text-red-400">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px] mt-[1.5px] flex-shrink-0">
                                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                                </svg>
                                <div className="whitespace-pre-wrap text-[14px] leading-relaxed break-words font-medium">
                                  {mainErr}
                                </div>
                              </div>
                              {hints.length > 0 && (
                                <div className="pl-[26px] mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-500 dark:text-gray-400 break-words opacity-90">
                                  <span className="font-medium">提示：</span>{hints.join('\n提示：')}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div data-selectable-text className={`text-[15px] leading-relaxed text-gray-800 dark:text-gray-100 ${!isAssistant ? 'select-text' : ''}`}>
                        {isAssistant ? (
                          <>
                            {assistantBlocks.length > 0 ? assistantBlocks.map((block, index) => {
                              if (block.type === 'web-search') return <AgentWebSearchStatusLines key={block.key} statuses={[block.status]} />
                              if (block.type === 'text') return <div key={block.key} className={index > 0 ? 'mt-3' : undefined}><MarkdownRenderer content={block.content ?? message.content} streaming={isStreamingAssistant} /></div>
                              if (block.type === 'batch-params') {
                                return (
                                  <div key={block.key} className={index > 0 ? 'mt-3' : undefined}>
                                    <AgentWebSearchInlineStatus status={block.status} />
                                  </div>
                                )
                              }
                              if (block.type === 'deleted-image-task') {
                                return (
                                  <div key={block.key} className="mt-4 w-full min-w-[16rem] max-w-sm rounded-xl bg-gray-50/50 dark:bg-white/[0.02] border border-dashed border-gray-200 dark:border-white/[0.08] p-4 flex min-h-[120px] flex-col items-center justify-center text-gray-400 dark:text-gray-500" onClick={e => e.stopPropagation()}>
                                    <TrashIcon className="w-6 h-6 mb-2 opacity-50" />
                                    <span className="text-xs">图片已移除</span>
                                  </div>
                                )
                              }
                              return (
                                <div key={block.key} className="mt-4 max-w-sm" onClick={e => e.stopPropagation()}>
                                  <TaskCard
                                    task={block.task}
                                    disableSwipe={true}
                                    onClick={() => setDetailTaskId(block.task.id)}
                                    onReuse={() => handleReuse(block.task)}
                                    onEditOutputs={() => editOutputs(block.task)}
                                    onDelete={() => openDestructiveConfirm({ title: '删除记录', message: '确定要删除这条记录吗？', confirmText: '删除记录', onConfirm: () => removeTask(block.task) })}
                                  />
                                  {block.task.outputImages.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => void sendTaskOutputsToGallery(block.task)}
                                      className="mt-2 w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                                    >
                                      发送到画廊继续编辑
                                    </button>
                                  )}
                                </div>
                              )
                            }) : isStreamingAssistant ? <AgentStreamingCursor /> : null}
                          </>
                        ) : parts.some((part) => part.type === 'mention') ? (
                          <div className="whitespace-pre-wrap break-words">
                            {parts.map((part, i) =>
                              part.type === 'text' ? <span key={i}>{part.text}</span> : <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-blue-100/50 text-blue-700 dark:bg-blue-500/30 dark:text-blue-300 text-xs font-medium mx-0.5 align-baseline">{part.text}</span>
                            )}
                          </div>
                        ) : (
                          <MarkdownRenderer content={parts[0]?.text ?? ''} />
                        )}
                      </div>
                    )}

                      </article>

                    {!isStreamingAssistant && <div className={`mt-2 flex w-full min-w-fit items-center justify-between gap-3 px-1 transition-opacity duration-200 ${isEditing || hasBranches ? 'opacity-100' : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100'}`} onClick={e => e.stopPropagation()}>
                      <div className="flex min-w-0 items-center gap-2">
                        {isEditing && (
                          <div className="inline-flex items-center rounded-md bg-blue-100 px-2 py-1 text-xs text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
                            <span className="truncate">正在编辑</span>
                            <AgentActionButton
                              tooltip="取消编辑"
                              className="ml-1 -mr-1 p-0.5 rounded-full hover:bg-blue-200 dark:hover:bg-blue-500/40 transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPrompt('');
                                setInputImages([]);
                                clearMaskDraft();
                                setAgentEditingRoundId(null);
                              }}
                            >
                              <CloseIcon className="w-3 h-3" />
                            </AgentActionButton>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-auto text-gray-400">
                        {!isAssistant && round && hasBranches && siblingIndex >= 0 && (
                          <div className="inline-flex items-center text-sm font-bold text-gray-400 dark:text-gray-500 mr-1">
                            <AgentActionButton tooltip="上一分支" className="p-1 rounded-md hover:bg-gray-200/50 dark:hover:bg-white/10 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" onClick={() => handleSwitchBranch(round, -1)}>
                              <ChevronLeftIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <span className="px-1 tabular-nums tracking-widest">{siblingIndex + 1}/{siblingRounds.length}</span>
                            <AgentActionButton tooltip="下一分支" className="p-1 rounded-md hover:bg-gray-200/50 dark:hover:bg-white/10 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" onClick={() => handleSwitchBranch(round, 1)}>
                              <ChevronRightIcon className="w-4 h-4" />
                            </AgentActionButton>
                          </div>
                        )}
                        {isAssistant ? (
                          <>
                            <AgentActionButton tooltip="复制输出文本" className={`p-1.5 rounded-md transition-colors ${message.content.trim() ? 'text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/[0.06]' : 'text-gray-300 dark:text-gray-600 opacity-50 cursor-not-allowed'}`} disabled={!message.content.trim()} onClick={() => {
                              void handleCopyMessage(getAgentAssistantCopyContent(message.content, assistantBlocks), '输出文本已复制', '复制输出文本失败');
                            }}>
                              <CopyIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip="重新生成" className="p-1.5 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors" onClick={() => {
                              if (conversation && round) void regenerateAgentAssistantMessage(conversation.id, round.id);
                            }}>
                              <RefreshIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip={allRoundTasksFavorited ? '取消收藏所有图片' : '收藏所有图片'} className={`p-1.5 rounded-md transition-colors ${hasRoundFavoriteTasks ? (allRoundTasksFavorited ? 'text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-500/10' : 'text-gray-400 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-500/10') : 'text-gray-300 dark:text-gray-600 opacity-50 cursor-not-allowed'}`} disabled={!hasRoundFavoriteTasks} onClick={() => {
                              if (!hasRoundFavoriteTasks) return;
                              const nextFavorite = !allRoundTasksFavorited;
                              favoriteTasksForRound.forEach(t => updateTaskInStore(t.id, { isFavorite: nextFavorite }));
                              useStore.getState().showToast(nextFavorite ? `已收藏 ${favoriteTasksForRound.length} 个任务的图片` : `已取消收藏 ${favoriteTasksForRound.length} 个任务的图片`, 'success');
                            }}>
                              <FavoriteIcon className="w-4 h-4" filled={allRoundTasksFavorited} />
                            </AgentActionButton>
                                                        <AgentActionButton tooltip="下载所有图片" className={`p-1.5 rounded-md transition-colors ${getRoundTasks(round ?? null, tasks).filter(Boolean).length > 0 ? 'text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-500/10' : 'text-gray-300 dark:text-gray-600 opacity-50 cursor-not-allowed'}`} disabled={getRoundTasks(round ?? null, tasks).filter(Boolean).length === 0} onClick={async () => {
                               const imageIds = tasksForRound.flatMap(t => t.outputImages || []);
                               if (imageIds.length === 0) return;
                               try {
                                 const roundIndex = round?.index ?? 0;
                                 const { successCount, failCount } = await downloadImageIds(imageIds, 'agent-round-' + roundIndex);
                                 if (successCount === 0) {
                                   useStore.getState().showToast('下载失败', 'error');
                                 } else if (failCount > 0) {
                                   useStore.getState().showToast('部分下载失败：成功 ' + successCount + '，失败 ' + failCount, 'error');
                                 } else {
                                   useStore.getState().showToast(successCount > 1 ? '下载成功：' + successCount + ' 张图片' : '下载成功', 'success');
                                 }
                                } catch (err) {
                                  logger.error('agent', 'Agent 消息下载失败', { error: serializeError(err) });
                                  useStore.getState().showToast('下载失败', 'error');
                               }
                             }}>
                               <DownloadIcon className="w-4 h-4" />
                             </AgentActionButton>
                            <AgentActionButton tooltip="删除消息" className="p-1.5 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-colors" onClick={() => {
                              if (round) handleDeleteMessage(message, round);
                            }}>
                              <TrashIcon className="w-4 h-4" />
                            </AgentActionButton>
                          </>
                        ) : (
                          <>
                            <AgentActionButton tooltip="复制提示词" className="p-1.5 rounded-md hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-white/[0.04] transition-colors" onClick={() => {
                              void handleCopyMessage(message.content);
                            }}>
                              <CopyIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip="编辑" className="p-1.5 rounded-md hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-white/[0.04] transition-colors" onClick={() => {
                               if (round) void handleEditRoundMessage(round, message.content);
                            }}>
                              <EditIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip="删除" className="p-1.5 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-colors" onClick={() => {
                              if (round) handleDeleteMessage(message, round);
                            }}>
                              <TrashIcon className="w-4 h-4" />
                            </AgentActionButton>
                          </>
                        )}
                      </div>
                    </div>}
                    </div>
                </div>
                )
              })

              const runningRounds = activeRounds.filter((round) =>
                round.status === 'running' &&
                !conversation.messages.some((message) => message.roundId === round.id && message.role === 'assistant'),
              )

              return (
                <>
                  {renderedMessages}
                  {runningRounds.map((round) => (
                    <div key={`running-${round.id}`} className="mb-4 flex w-full justify-start">
                      <article className="flex min-w-[16rem] max-w-[95%] flex-col rounded-2xl rounded-tl-md border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.035] md:max-w-[88%] lg:max-w-[82%] sm:p-5">
                        <div className="mb-3 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                          <span className="font-semibold text-blue-600 dark:text-blue-400">PicPilot Agent</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500">第 {round.index} 轮</span>
                          <span className="inline-flex h-5 items-center rounded-md bg-blue-50 px-1.5 text-[11px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">生成中</span>
                        </div>
                        <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                          <span>正在规划回复和图像工具调用</span>
                        </div>
                      </article>
                    </div>
                  ))}
                </>
              )
            })()
          )}
          <div ref={bottomSentinelRef} aria-hidden="true" />
        </div>

        {!isScrolledToBottom && activeMessages.length > 0 && (
          <button
            onClick={scrollToAgentBottom}
            className="fixed bottom-[calc(var(--input-bar-clearance,12rem)+1.5rem)] left-1/2 z-30 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-gray-200/50 bg-white/90 text-gray-500 shadow-[0_2px_12px_rgba(0,0,0,0.1)] backdrop-blur transition-all duration-300 hover:bg-gray-50 hover:text-gray-800 dark:border-white/[0.08] dark:bg-gray-800/90 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="滚动到底部"
          >
            <ArrowDownIcon className="h-5 w-5" />
          </button>
        )}
      </section>
    </main>
  )
}
