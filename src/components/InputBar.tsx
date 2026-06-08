import { useRef, useEffect, useCallback, useState, useMemo, useLayoutEffect } from 'react'
import { useStore, submitTask, submitAgentMessage, submitVideoTask, stopAgentResponse, createInputImageFromFile, deleteImageIfUnreferenced, ensureImageCached } from '../store'
import { DEFAULT_PARAMS } from '../types'
import type { MultiImageMode, TaskRecord } from '../types'
import { getActiveApiProfile, normalizeSettings, validateApiProfile } from '../lib/apiProfiles'
import { getChangedParams, getOutputImageLimitForSettings, normalizeParamsForSettings } from '../lib/paramCompatibility'
import { getProviderCapabilities } from '../lib/imageProviderCapabilities'
import { normalizeImageSize } from '../lib/size'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { getParamValueLabel, getUserFacingErrorMessage } from '../lib/userFacingText'
import { useHintTooltip } from '../hooks/useHintTooltip'
import { useIsMobile } from '../hooks/useIsMobile'
import SizePickerModal from './SizePickerModal'
import { API_MAX_IMAGES } from './inputBar/constants'
import InputBarBatchToolbar from './inputBar/InputBarBatchToolbar'
import InputBarDragOverlay from './inputBar/InputBarDragOverlay'
import InputBarImageStrip from './inputBar/InputBarImageStrip'
import InputBarParamsPanel from './inputBar/InputBarParamsPanel'
import InputBarPromptEditor from './inputBar/InputBarPromptEditor'
import InputBarActions, { InputBarFileInputs } from './inputBar/InputBarActions'
import { useInputBarFileUpload } from './inputBar/useInputBarFileUpload'
import { useInputBarPromptEditor } from './inputBar/useInputBarPromptEditor'
import { useAuth } from '../contexts/AuthProvider'
import Select from './Select'



// 画廊模式下 InputBar 不需要 tasks（仅 agent 模式的 @图选项用到）。返回稳定的空引用，
// 让出图过程中高频的 task 更新不再重渲整个 InputBar。
const EMPTY_TASKS: TaskRecord[] = []

const PROMPT_TEMPLATES = [
  {
    id: 'product-main',
    label: '商品主图',
    text: '电商商品主图，纯净背景，主体居中，真实材质，边缘清晰，高级摄影布光，保留产品结构与比例，不添加无关文字。',
  },
  {
    id: 'lifestyle',
    label: '场景图',
    text: '商品生活方式场景图，真实使用环境，自然光线，画面干净，主体清楚可见，适合电商详情页展示。',
  },
  {
    id: 'detail',
    label: '细节卖点',
    text: '商品细节特写，突出材质、工艺和关键卖点，背景简洁，微距摄影质感，画面适合放入详情页卖点模块。',
  },
  {
    id: 'variant',
    label: '变体延展',
    text: '基于参考图延展同系列视觉，保持主体一致、风格一致、光线一致，只调整构图和场景，适合生成多张可比较变体。',
  },
] as const

export default function InputBar() {
  const prompt = useStore((s) => s.prompt)
  const appMode = useStore((s) => s.appMode)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const addInputImage = useStore((s) => s.addInputImage)
  const replaceInputImage = useStore((s) => s.replaceInputImage)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const reusedTaskApiProfileId = useStore((s) => s.reusedTaskApiProfileId)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const tasks = useStore((s) => (s.appMode === 'agent' ? s.tasks : EMPTY_TASKS))
  const activeAgentConversationId = useStore((s) => s.activeAgentConversationId)
  // 直接订阅当前会话对象（引用稳定）：画廊模式恒为 null，agent 模式仅在该会话变化时重渲。
  const activeAgentConversation = useStore((s) =>
    s.appMode === 'agent'
      ? s.agentConversations.find((conversation) => conversation.id === s.activeAgentConversationId) ?? null
      : null,
  )
  const { user } = useAuth()

  const maskDraft = useStore((s) => s.maskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const moveInputImage = useStore((s) => s.moveInputImage)

  const replaceFileInputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const imagesRef = useRef<HTMLDivElement>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [mobileCollapsed, setMobileCollapsed] = useState(true)
  const [showSizePicker, setShowSizePicker] = useState(false)
  const [maskPreviewUrl, setMaskPreviewUrl] = useState('')
  const [promptTemplateId, setPromptTemplateId] = useState('')
  const handleRef = useRef<HTMLDivElement>(null)
  const dragTouchRef = useRef({ startY: 0, moved: false })
  const suppressHandleClickUntilRef = useRef(0)
  const replaceImageTargetRef = useRef<{ index: number; id: string } | null>(null)
  const fileUpload = useInputBarFileUpload()
  const { fileInputRef, cameraInputRef, handleFilesRef, handleFileUpload } = fileUpload

  const updateInputBarClearance = useCallback(() => {
    const bar = cardRef.current?.closest<HTMLElement>('[data-input-bar]')
    if (!bar) return

    const rect = bar.getBoundingClientRect()
    const clearance = Math.max(0, window.innerHeight - rect.top)
    document.documentElement.style.setProperty('--input-bar-clearance', `${Math.ceil(clearance)}px`)
  }, [])

  useLayoutEffect(() => {
    const bar = cardRef.current?.closest<HTMLElement>('[data-input-bar]')
    if (!bar) return

    const frame = window.requestAnimationFrame(updateInputBarClearance)
    const observer = new ResizeObserver(updateInputBarClearance)
    observer.observe(bar)

    const visualViewport = window.visualViewport
    window.addEventListener('resize', updateInputBarClearance)
    visualViewport?.addEventListener('resize', updateInputBarClearance)
    visualViewport?.addEventListener('scroll', updateInputBarClearance)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', updateInputBarClearance)
      visualViewport?.removeEventListener('resize', updateInputBarClearance)
      visualViewport?.removeEventListener('scroll', updateInputBarClearance)
      document.documentElement.style.removeProperty('--input-bar-clearance')
    }
  }, [updateInputBarClearance])
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)
  const dragCounter = useRef(0)
  const isMobile = useIsMobile()

  const currentActiveProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeProfile = useMemo(() => (
    settings.reuseTaskApiProfileTemporarily && reusedTaskApiProfileId
      ? settings.profiles.find((profile) => profile.id === reusedTaskApiProfileId) ?? currentActiveProfile
      : currentActiveProfile
  ), [currentActiveProfile, reusedTaskApiProfileId, settings])
  const activeAgentIsRunning = Boolean(activeAgentConversation?.rounds.some((round) => round.status === 'running'))
  const isVideoMode = appMode === 'video'
  const effectiveSettings = useMemo(() => (
    activeProfile.id === currentActiveProfile.id
      ? settings
      : normalizeSettings({ ...settings, activeProfileId: activeProfile.id })
  ), [activeProfile.id, currentActiveProfile.id, settings])
  const hasSubmitApiConfig = isVideoMode || !validateApiProfile(activeProfile)
  const canSubmit = Boolean(prompt.trim() && hasSubmitApiConfig && !activeAgentIsRunning)
  const submitButtonAriaLabel = activeAgentIsRunning
    ? '停止生成'
    : hasSubmitApiConfig
    ? appMode === 'agent' ? '发送消息' : isVideoMode ? '生成视频' : maskDraft ? '遮罩编辑' : '生成图像'
    : '请先配置 API 与模型'
  const submitTooltipText = activeAgentIsRunning ? '停止生成' : '尚未完成 API 与模型配置，请在右上角设置中进行'
  const submitCurrentMode = useCallback(() => {
    if (appMode === 'agent') {
      void submitAgentMessage()
    } else if (appMode === 'video') {
      void submitVideoTask()
    } else {
      void submitTask()
    }
  }, [appMode])

  const promptEditor = useInputBarPromptEditor({
    prompt,
    setPrompt,
    inputImages,
    imagesRef,
    tasks,
    activeAgentConversation,
    enterSubmit: settings.enterSubmit,
    canSubmit,
    onSubmit: submitCurrentMode,
    maskDraft,
    maskPreviewUrl,
    promptPlaceholder: appMode === 'agent'
      ? '输入给 Agent 的任务，可输入 @ 引用图片...'
      : isVideoMode
      ? '描述你想生成的视频...'
      : undefined,
  })
  const {
    textareaRef,
    isUserInputRef,
    syncPromptFromContentEditable,
  } = promptEditor

  const stopActiveAgentResponse = useCallback(() => {
    stopAgentResponse(activeAgentConversationId)
  }, [activeAgentConversationId])
  const agentAutoImageCount = appMode === 'agent'
  const compressionDisabled = !getProviderCapabilities(activeProfile.provider).supportsCompression || params.output_format === 'png'
  const providerOutputImageLimit = getOutputImageLimitForSettings(effectiveSettings)
  const outputImageLimit = getOutputImageLimitForSettings(effectiveSettings, user?.maxBatchImages)
  const limitedByAdminBatchLimit = Boolean(user && user.maxBatchImages < providerOutputImageLimit)
  const nDraftValue = Number(nInput)
  const effectiveNValue = Number.isNaN(nDraftValue) ? params.n : nDraftValue
  const streamConcurrentByN = activeProfile.provider === 'openai' && activeProfile.streamImages === true && !agentAutoImageCount && effectiveNValue > 1
  const nLimitHintText = agentAutoImageCount
    ? 'Agent 模式下数量由模型根据提示词自动决定'
    : limitedByAdminBatchLimit
    ? `管理员设置单次最多生成 ${outputImageLimit} 张`
    : `OpenAI 最大请求数量为 ${outputImageLimit}`
  const displaySize = getParamValueLabel('size', normalizeImageSize(params.size) || DEFAULT_PARAMS.size)

  const qualityOptions = [
    { label: '自动', value: 'auto' },
    { label: '低', value: 'low' },
    { label: '中', value: 'medium' },
    { label: '高', value: 'high' },
  ]
  const inputImageLimit = isVideoMode ? 1 : API_MAX_IMAGES
  const atImageLimit = inputImages.length >= inputImageLimit
  const uploadImageTooltipText = atImageLimit ? `参考图数量已达上限（${inputImageLimit} 张），无法继续添加` : '上传图片'
  const compressionHint = useHintTooltip({ enabled: () => compressionDisabled })
  const qualityHint = useHintTooltip({ enabled: () => settings.codexCli || !getProviderCapabilities(activeProfile.provider).supportsQuality })
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })
  const maskTargetImage = maskDraft
    ? inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages

  // 多图发送模式（拆分按钮）：仅画廊模式、无遮罩、参考图 ≥2 张时可用
  const canPerImageSplit = appMode === 'gallery' && !maskDraft && referenceImages.length >= 2
  const effectiveSubmitN = Math.min(outputImageLimit, Math.max(1, effectiveNValue || 1))
  const perImageOutputCount = referenceImages.length * effectiveSubmitN
  const mergeOutputCount = effectiveSubmitN
  const activeMultiImageMode = settings.multiImageMode
  // 仅切换发送模式（改变主按钮功能），由用户点击主按钮再发送
  const selectMultiImageMode = useCallback((mode: MultiImageMode) => {
    if (useStore.getState().settings.multiImageMode !== mode) setSettings({ multiImageMode: mode })
  }, [setSettings])

  const applyPromptTemplate = useCallback((templateId: string) => {
    setPromptTemplateId(templateId)
    const template = PROMPT_TEMPLATES.find((item) => item.id === templateId)
    if (!template) return
    const current = useStore.getState().prompt.trim()
    setPrompt(current ? `${current}\n\n${template.text}` : template.text)
    setPromptTemplateId('')
  }, [setPrompt])

  useEffect(() => {
    setOutputCompressionInput(
      params.output_compression == null ? '' : String(params.output_compression),
    )
  }, [params.output_compression])

  useEffect(() => {
    setNInput(agentAutoImageCount ? '自动' : String(params.n))
  }, [agentAutoImageCount, params.n])

  useEffect(() => {
    const normalizedParams = normalizeParamsForSettings(params, effectiveSettings, {
      hasInputImages: inputImages.length > 0,
      maxOutputImages: user?.maxBatchImages,
    })
    const patch = getChangedParams(params, normalizedParams)
    if (Object.keys(patch).length) {
      setParams(patch)
    }
  }, [inputImages.length, params, effectiveSettings, setParams, user?.maxBatchImages])


  useEffect(() => {
    let cancelled = false
    if (!maskDraft || !maskTargetImage) {
      setMaskPreviewUrl('')
      return
    }

    createMaskPreviewDataUrl(maskTargetImage.dataUrl, maskDraft.maskDataUrl)
      .then((url) => {
        if (!cancelled) setMaskPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [maskDraft, maskTargetImage?.id, maskTargetImage?.dataUrl])

  const commitOutputCompression = useCallback(() => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }, [outputCompressionInput, params.output_compression, setParams])

  const commitN = useCallback(() => {
    nLimitHint.hide()
    if (agentAutoImageCount) {
      setNInput('自动')
      return
    }
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(outputImageLimit, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }, [agentAutoImageCount, nInput, nLimitHint, outputImageLimit, params.n, setParams])

  const showNLimitHint = useCallback(() => {
    nLimitHint.show()
  }, [nLimitHint])

  const hideNLimitHint = useCallback(() => {
    nLimitHint.hide()
  }, [nLimitHint])

  const showAgentNHint = useCallback(() => {
    if (agentAutoImageCount) showNLimitHint()
  }, [agentAutoImageCount, showNLimitHint])

  const clearAgentNHintTouchTimer = useCallback(() => {
    nLimitHint.clearTimer()
  }, [nLimitHint])

  const startAgentNHintTouch = useCallback(() => {
    if (!agentAutoImageCount) return
    nLimitHint.startTouch()
  }, [agentAutoImageCount, nLimitHint])

  const handleNInputChange = useCallback((value: string) => {
    if (agentAutoImageCount) {
      setNInput('自动')
      return
    }
    setNInput(value)
    const nextValue = Number(value)
    if (!Number.isNaN(nextValue) && nextValue > outputImageLimit) {
      showNLimitHint()
    } else {
      hideNLimitHint()
    }
  }, [agentAutoImageCount, hideNLimitHint, outputImageLimit, showNLimitHint])

  const handleNLimitIncreaseAttempt = useCallback((preventDefault: () => void) => {
    if (agentAutoImageCount) {
      preventDefault()
      showNLimitHint()
      return
    }
    const currentValue = Number(nInput)
    const effectiveValue = Number.isNaN(currentValue) ? params.n : currentValue
    if (!nInputFocused || effectiveValue < outputImageLimit) return

    preventDefault()
    showNLimitHint()
  }, [agentAutoImageCount, nInput, nInputFocused, outputImageLimit, params.n, showNLimitHint])

  const openReplaceReferenceFilePicker = useCallback((idx: number, imageId: string) => {
    replaceImageTargetRef.current = { index: idx, id: imageId }
    replaceFileInputRef.current?.click()
  }, [])

  const commitReferenceEditChoice = useCallback((choice: 'replace-reference' | 'add-mask', remember?: boolean) => {
    if (remember) setSettings({ referenceImageEditAction: choice })
  }, [setSettings])

  const handleEditReferenceImage = useCallback((img: (typeof inputImages)[number], idx: number, isMaskTarget: boolean) => {
    if (isMaskTarget) {
      setMaskEditorImageId(img.id)
      return
    }

    if (settings.referenceImageEditAction === 'replace-reference') {
      openReplaceReferenceFilePicker(idx, img.id)
      return
    }

    if (settings.referenceImageEditAction === 'add-mask') {
      setMaskEditorImageId(img.id)
      return
    }

    setConfirmDialog({
      title: '编辑参考图',
      message: '请选择这次要执行的操作。若不勾选下方的选项，则每次都询问；勾选后可在 **设置-习惯配置** 修改选择。',
      checkbox: { label: '以后默认执行此选择' },
      buttons: [
        {
          label: '替换参考图',
          tone: 'secondary',
          action: (remember) => {
            commitReferenceEditChoice('replace-reference', remember)
            openReplaceReferenceFilePicker(idx, img.id)
          },
        },
        {
          label: '添加遮罩',
          tone: 'primary',
          action: (remember) => {
            commitReferenceEditChoice('add-mask', remember)
            setMaskEditorImageId(img.id)
          },
        },
      ],
    })
  }, [commitReferenceEditChoice, openReplaceReferenceFilePicker, setConfirmDialog, setMaskEditorImageId, settings.referenceImageEditAction])

  const handleReplaceFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const target = replaceImageTargetRef.current
    replaceImageTargetRef.current = null
    if (!file || !target) return

    try {
      const image = await createInputImageFromFile(file)
      if (!image) {
        showToast('请选择有效的图片文件。', 'error')
        return
      }

      const currentImages = useStore.getState().inputImages
      const currentIdx = currentImages.findIndex((item) => item.id === target.id)
      const targetIdx = currentIdx >= 0 ? currentIdx : target.index
      const previous = currentImages[targetIdx]
      if (!previous) {
        void deleteImageIfUnreferenced(image.id)
        showToast('原参考图已不存在，无法替换。', 'error')
        return
      }
      if (previous.id === image.id) {
        showToast('参考图未变化', 'info')
        return
      }
      if (currentImages.some((item, itemIdx) => itemIdx !== targetIdx && item.id === image.id)) {
        showToast('这张图片已在参考图中', 'info')
        return
      }

      replaceInputImage(targetIdx, image)
      showToast('参考图已替换', 'success')
    } catch (err) {
      showToast(`参考图替换失败：${getUserFacingErrorMessage(err, '请确认文件是有效图片')}`, 'error')
    }
  }

  // 粘贴图片
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        handleFilesRef.current(imageFiles)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // 拖拽图片 - 监听整个页面
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        handleFilesRef.current(files)
        return
      }

      const transferredText = e.dataTransfer?.getData('text/plain')
      
      const imageIds = transferredText?.startsWith('agent-images:') 
        ? transferredText.slice('agent-images:'.length).split(',') 
        : transferredText?.startsWith('agent-image:')
        ? [transferredText.slice('agent-image:'.length)]
        : []

      if (imageIds.length > 0) {
        Promise.all(imageIds.map(async (imageId) => {
          const dataUrl = await ensureImageCached(imageId)
          if (!dataUrl) {
            showToast('部分图片已不存在', 'error')
            return
          }
          addInputImage({ id: imageId, dataUrl })
        })).then(() => {
          showToast('已上传图片', 'success')
        }).catch((err) => showToast(`上传图片失败：${getUserFacingErrorMessage(err, '请确认图片仍然存在')}`, 'error'))
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [addInputImage, showToast])

  // 移动端拖动条手势
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    const onTouchStart = (e: TouchEvent) => {
      dragTouchRef.current = { startY: e.touches[0].clientY, moved: false }
    }
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - dragTouchRef.current.startY
      if (Math.abs(dy) > 10) dragTouchRef.current.moved = true
      if (dy > 30) setMobileCollapsed(true)
      if (dy < -30) setMobileCollapsed(false)
    }
    const onTouchEnd = () => {
      if (dragTouchRef.current.moved) {
        suppressHandleClickUntilRef.current = Date.now() + 500
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [])


  const actionProps = {
    atImageLimit,
    uploadImageTooltipText,
    activeAgentIsRunning,
    hasSubmitApiConfig,
    canSubmit,
    submitButtonAriaLabel,
    submitTooltipText,
    maskDraft,
    fileInputRef,
    cameraInputRef,
    canPerImageSplit,
    activeMultiImageMode,
    perImageOutputCount,
    mergeOutputCount,
    onSelectMode: selectMultiImageMode,
    onSubmit: submitCurrentMode,
    onStopAgent: stopActiveAgentResponse,
    onOpenSettings: () => setShowSettings(true),
    submitIdleLabel: appMode === 'agent'
      ? '发送消息'
      : isVideoMode
      ? '生成视频'
      : maskDraft
      ? '遮罩编辑'
      : '生成图像',
  }

  const renderImageThumbs = () => (
    <InputBarImageStrip
      imagesRef={imagesRef}
      inputImages={inputImages}
      maskDraft={maskDraft}
      maskTargetImage={maskTargetImage}
      referenceImages={referenceImages}
      maskPreviewUrl={maskPreviewUrl}
      isMobile={isMobile}
      prompt={prompt}
      setPrompt={setPrompt}
      syncPromptFromContentEditable={syncPromptFromContentEditable}
      textareaRef={textareaRef}
      isUserInputRef={isUserInputRef}
      moveInputImage={moveInputImage}
      removeInputImage={removeInputImage}
      clearInputImages={clearInputImages}
      setMaskEditorImageId={setMaskEditorImageId}
      setLightboxImageId={setLightboxImageId}
      showToast={showToast}
      setConfirmDialog={setConfirmDialog}
      onEditReferenceImage={handleEditReferenceImage}
    />
  )

  const renderParams = (cols: string) => (
    <InputBarParamsPanel
      cols={cols}
      params={params}
      setParams={setParams}
      settings={settings}
      provider={activeProfile.provider}
      displaySize={displaySize}
      qualityOptions={qualityOptions}
      compressionDisabled={compressionDisabled}
      agentAutoImageCount={agentAutoImageCount}
      outputImageLimit={outputImageLimit}
      nLimitHintText={nLimitHintText}
      streamConcurrentByN={streamConcurrentByN}
      outputCompressionInput={outputCompressionInput}
      setOutputCompressionInput={setOutputCompressionInput}
      commitOutputCompression={commitOutputCompression}
      nInput={nInput}
      setNInputFocused={setNInputFocused}
      handleNInputChange={handleNInputChange}
      commitN={commitN}
      handleNLimitIncreaseAttempt={handleNLimitIncreaseAttempt}
      showAgentNHint={showAgentNHint}
      hideNLimitHint={hideNLimitHint}
      startAgentNHintTouch={startAgentNHintTouch}
      clearAgentNHintTouchTimer={clearAgentNHintTouchTimer}
      setShowSizePicker={setShowSizePicker}
      qualityHint={qualityHint}
      compressionHint={compressionHint}
      nLimitHint={nLimitHint}
    />
  )

  const renderVideoParams = (cols: string) => (
    <div className={`grid ${cols} gap-2 text-xs flex-1`}>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">时长</span>
        <Select
          value={settings.videoDurationSeconds}
          onChange={(value) => setSettings({ videoDurationSeconds: Number(value) })}
          options={[
            { label: '6 秒', value: 6 },
            { label: '10 秒', value: 10 },
            { label: '15 秒', value: 15 },
          ]}
          className="px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">模型</span>
        <div className="px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-100/50 dark:bg-white/[0.05] text-xs text-gray-500 dark:text-gray-400">
          Grok Video
        </div>
      </label>
    </div>
  )

  return (
    <>
      <InputBarDragOverlay visible={isDragging} atImageLimit={atImageLimit} />

      {showSizePicker && (
        <SizePickerModal
          currentSize={params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
          allowAuto
          provider={activeProfile.provider}
        />
      )}

      <div data-input-bar className="fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-30 w-full max-w-4xl px-3 sm:px-4 transition-all duration-300">
        <InputBarBatchToolbar />
        <div ref={cardRef} className="bg-white/70 dark:bg-gray-900/70 backdrop-blur-2xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] rounded-2xl sm:rounded-3xl p-3 sm:p-4 ring-1 ring-black/5 dark:ring-white/10">
          {/* 移动端拖动条 */}
          <div
            ref={handleRef}
            className="sm:hidden flex justify-center pt-0.5 pb-2 -mt-1 cursor-pointer touch-none"
            onClick={() => {
              if (Date.now() < suppressHandleClickUntilRef.current) {
                suppressHandleClickUntilRef.current = 0
                return
              }
              setMobileCollapsed((v) => !v)
            }}
          >
            <div className={`w-10 h-1 rounded-full bg-gray-300 dark:bg-white/[0.06] transition-transform duration-200 ${mobileCollapsed ? 'scale-x-75' : ''}`} />
          </div>

          {/* 输入图片行（移动端可折叠） */}
          {inputImages.length > 0 && (
            isMobile ? (
              <>
                {!mobileCollapsed && renderImageThumbs()}
                {mobileCollapsed && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mb-2 ml-1">
                    {maskDraft ? `1 张遮罩主图 · ${referenceImages.length} 张参考图` : `${inputImages.length} 张参考图`}
                  </div>
                )}
              </>
            ) : (
              renderImageThumbs()
            )
          )}

          {/* 输入框 */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              value={promptTemplateId}
              onChange={(e) => applyPromptTemplate(e.target.value)}
              className="rounded-lg border border-gray-200/60 bg-white/60 px-2.5 py-1 text-xs text-gray-600 shadow-sm transition-colors hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              <option value="">提示词模板</option>
              {PROMPT_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>{template.label}</option>
              ))}
            </select>
          </div>
          <InputBarPromptEditor prompt={prompt} {...promptEditor} />

          {/* 参数 + 按钮 */}
          <div className="mt-3">
            {/* 桌面端布局 */}
            <div className="hidden sm:flex items-end justify-between gap-3">
              {isVideoMode ? renderVideoParams('grid-cols-2') : renderParams('grid-cols-6')}

              <InputBarActions variant="desktop" {...actionProps} />
            </div>

            {/* 移动端布局 */}
            <div className="sm:hidden flex flex-col gap-2">
              {!mobileCollapsed && (
                <>
                  {isVideoMode ? renderVideoParams('grid-cols-2') : renderParams('grid-cols-2')}
                  <div className="h-2" />
                </>
              )}

              <InputBarActions variant="mobile" {...actionProps} />
            </div>
          </div>

          <InputBarFileInputs
            fileInputRef={fileInputRef}
            cameraInputRef={cameraInputRef}
            onFileUpload={handleFileUpload}
          />
          <input
            ref={replaceFileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleReplaceFileUpload}
          />
        </div>
      </div>
    </>
  )
}
