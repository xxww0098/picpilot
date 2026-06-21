// 画布 AI 输入面板：底部输入条 + 生成/标注迭代按钮。
// 复用 gpt-5.5 的 callAgentResponsesApi（经 canvasGenerate 封装），不依赖 AgentConversation。
// 生成模式：
//   - 普通生成：选中 AI 占位框→文生图填入；选中 image→图生图放原图旁；都没选→独立文生图
//   - 标注迭代：选中图（其上画了红色箭头/批注）→ 截图（图+标注）→ AI 读标注生成干净修订版放原图旁
import { useCallback, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { useStore } from '../../store'
import { generateCanvasImage, persistCanvasImage, type CanvasGenerateError } from '../../lib/canvas/canvasGenerate'
import {
  getSelectedAiHolder,
  getSelectedImageDataUrl,
  insertCanvasImage,
} from '../../lib/canvas/canvasImageAsset'
import { mapHolderRatioToOutputSize, sizeToString } from '../../lib/canvas/placement'
import { captureImageWithAnnotations } from '../../lib/canvas/captureSnapshot'

const CANVAS_DEFAULT_DISPLAY_W = 512

// 标注迭代的系统引导：让 AI 把截图里的箭头/文字批注当编辑指令，输出无标注的干净图。
const ANNOTATION_EDIT_PROMPT_PREFIX =
  '这是一张带红色箭头和文字批注的截图。请仔细阅读所有标注（箭头指向的位置、文字说明的修改要求），' +
  '按标注的要求修改图片，生成一张干净的新图。注意：\n' +
  '- 移除所有标注痕迹（红色箭头、文字标签、批注框、工具 UI）\n' +
  '- 保留原图的主体、构图、风格，只按批注要求修改\n' +
  '- 输出干净的新图，不要包含任何标注\n\n用户的具体要求：'

function readNaturalSizeFromDataUrl(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 })
    img.onerror = () => resolve({ width: 1024, height: 1024 })
    img.src = dataUrl
  })
}

interface CanvasAgentPanelProps {
  editorRef: React.MutableRefObject<Editor | null>
}

export default function CanvasAgentPanel({ editorRef }: CanvasAgentPanelProps) {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyMode, setBusyMode] = useState<'generate' | 'annotation' | null>(null)
  const [streamPreview, setStreamPreview] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const runGenerate = useCallback(
    async (
      mode: 'generate' | 'annotation',
      userPrompt: string,
    ) => {
      const editor = editorRef.current
      if (!editor) return
      if (busy) return

      const trimmed = userPrompt.trim()
      if (!trimmed) {
        showToast('请输入描述', 'error')
        return
      }

      // 识别选中对象
      const holder = getSelectedAiHolder(editor)
      const selectedImage = !holder ? getSelectedImageDataUrl(editor) : null

      // 标注迭代模式必须选中一张图
      if (mode === 'annotation' && !selectedImage) {
        showToast('请先选中要迭代的图片（在图上画好红色箭头/批注后再点标注迭代）', 'info')
        return
      }
      // 占位框 + 标注迭代无意义，回退普通生成
      const effectiveMode = mode === 'annotation' && holder ? 'generate' : mode

      setBusy(true)
      setBusyMode(effectiveMode)
      setStreamPreview(null)
      const controller = new AbortController()
      abortRef.current = controller

      try {
        let referenceImages: string[] = []
        let finalPrompt = trimmed

        if (effectiveMode === 'annotation' && selectedImage) {
          // 截图：选中图 + 画面上所有标注（箭头/文字）
          const screenshot = await captureImageWithAnnotations(editor, selectedImage.shapeId, {
            background: true,
          })
          if (!screenshot) {
            showToast('无法截图，请确保图片可见', 'error')
            return
          }
          referenceImages = [screenshot]
          finalPrompt = ANNOTATION_EDIT_PROMPT_PREFIX + trimmed
        } else if (selectedImage) {
          // 普通图生图：选中图作参考
          referenceImages = [selectedImage.dataUrl]
        }

        const sizeHint = holder ? mapHolderRatioToOutputSize(holder.w, holder.h) : undefined

        const { images } = await generateCanvasImage(settings, {
          prompt: finalPrompt,
          inputImageDataUrls: referenceImages.length > 0 ? referenceImages : undefined,
          params: sizeHint ? { size: sizeToString(sizeHint) } : undefined,
          signal: controller.signal,
          onPartialImage: (image) => setStreamPreview(image),
        })

        const image = images[0]
        if (!image?.dataUrl) {
          showToast('未生成图片', 'error')
          return
        }

        const imageId = await persistCanvasImage(image.dataUrl)
        const natural = await readNaturalSizeFromDataUrl(image.dataUrl)

        // 计算显示尺寸
        let displayW: number
        let displayH: number
        if (holder) {
          displayW = holder.w
          displayH = holder.h
        } else if (selectedImage) {
          // 图生图 / 标注迭代：匹配原图显示尺寸
          displayW = selectedImage.bounds.w
          displayH = selectedImage.bounds.h
        } else {
          displayW = Math.min(natural.width, CANVAS_DEFAULT_DISPLAY_W)
          displayH = Math.round(displayW * (natural.height / natural.width))
        }

        insertCanvasImage(editor, {
          imageId,
          dataUrl: image.dataUrl,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          displayWidth: displayW,
          displayHeight: displayH,
          holder: holder ? { id: holder.id } : null,
          anchorShapeId: selectedImage?.shapeId ?? null,
          placement: selectedImage ? 'right' : undefined,
          margin: 40,
        })

        setPrompt('')
        const successMsg = effectiveMode === 'annotation'
          ? '已按标注生成修订图，原图和标注保留'
          : selectedImage
            ? '已基于选中图生成新图'
            : holder
              ? '已生成并填入占位框'
              : '已生成图片'
        showToast(successMsg, 'success')
      } catch (err) {
        const canvasErr = err as CanvasGenerateError
        if (canvasErr?.canvasErrorKind === 'config') {
          showToast(canvasErr.message, 'error')
        } else if (canvasErr?.canvasErrorKind === 'no-output') {
          showToast(canvasErr.message, 'info')
        } else if (canvasErr?.name === 'AbortError' || /abort|stop/i.test(canvasErr?.message ?? '')) {
          showToast('已停止生成', 'info')
        } else {
          showToast(canvasErr?.message ?? '生成失败', 'error')
        }
      } finally {
        setBusy(false)
        setBusyMode(null)
        setStreamPreview(null)
        abortRef.current = null
      }
    },
    [editorRef, settings, busy, showToast],
  )

  const handleGenerate = useCallback(() => {
    void runGenerate('generate', prompt)
  }, [runGenerate, prompt])

  const handleAnnotationEdit = useCallback(() => {
    void runGenerate('annotation', prompt)
  }, [runGenerate, prompt])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return (
    <div className="border-t border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-950 px-3 py-2.5 shrink-0">
      {streamPreview && (
        <div className="mb-2 flex items-center gap-2">
          <img
            src={streamPreview}
            alt="生成预览"
            className="h-16 w-16 object-cover rounded border border-gray-200 dark:border-white/10"
          />
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {busyMode === 'annotation' ? '按标注生成中…' : '生成中…'}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              handleGenerate()
            }
          }}
          placeholder={
            busy
              ? '生成中…'
              : '描述要生成的图片；选中图片后可点「标注迭代」按批注修改'
          }
          disabled={busy}
          className="flex-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-gray-900 px-3.5 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60"
        />
        {!busy ? (
          <>
            <button
              type="button"
              onClick={handleAnnotationEdit}
              disabled={!prompt.trim()}
              title="选中图片后，把它和画布上的红色箭头/文字批注一起截图，让 AI 按标注生成干净的新图"
              className="shrink-0 px-3 py-2 rounded-xl text-sm bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              标注迭代
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!prompt.trim()}
              className="shrink-0 px-4 py-2 rounded-xl text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              生成
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            className="shrink-0 px-4 py-2 rounded-xl text-sm bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-white/20"
          >
            停止
          </button>
        )}
      </div>
    </div>
  )
}
