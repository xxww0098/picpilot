import { memo, useCallback, useRef } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { downloadDataUrl, downloadWorkflowImages, workflowImageFilename } from '../../lib/workflow/download'
import {
  HANDLE,
  type GenerateNode,
  type InputNode,
  type NodeRunStatus,
  type OutputNode,
  type TextNode,
  type WorkflowImage,
} from '../../lib/workflow/types'

// ============================================================================
// 自定义节点组件(贴合 picpilot 设计系统:hsl CSS 变量 + Tailwind)
// ============================================================================

const HANDLE_CLASS = '!h-3 !w-3 !border-2 !border-[hsl(var(--background))] !bg-[hsl(var(--primary))]'

function NodeShell({
  title,
  status,
  children,
  accent,
}: {
  title: string
  status?: NodeRunStatus
  accent?: string
  children: React.ReactNode
}) {
  return (
    <div
      className="w-60 overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-sm transition-shadow"
      style={status === 'running' ? { boxShadow: '0 0 0 2px hsl(var(--primary))' } : undefined}
    >
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent ?? 'hsl(var(--primary))' }} />
        <span className="truncate text-sm font-semibold text-[hsl(var(--foreground))]">{title}</span>
        {status && status !== 'idle' && <StatusBadge status={status} />}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: NodeRunStatus }) {
  const map: Record<NodeRunStatus, { label: string; cls: string }> = {
    idle: { label: '', cls: '' },
    running: { label: '生成中', cls: 'bg-[hsl(var(--primary))/0.15] text-[hsl(var(--primary))]' },
    done: { label: '完成', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    error: { label: '失败', cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  }
  const item = map[status]
  if (!item.label) return null
  return <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${item.cls}`}>{item.label}</span>
}

function ImageGrid({ images, empty, downloadLabel }: { images: WorkflowImage[]; empty: string; downloadLabel?: string }) {
  if (images.length === 0) {
    return <div className="rounded-lg border border-dashed border-[hsl(var(--border))] py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">{empty}</div>
  }
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {images.map((img, i) => (
        <div key={img.id} className="group relative">
          <img
            src={img.dataUrl}
            alt=""
            className="aspect-square w-full rounded-md border border-[hsl(var(--border))] object-cover"
          />
          {downloadLabel && (
            <button
              type="button"
              onClick={() => downloadDataUrl(img.dataUrl, workflowImageFilename(downloadLabel, i, img.dataUrl))}
              className="nodrag absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-black/60 text-[10px] leading-none text-white group-hover:flex"
              aria-label="下载"
            >
              ↓
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

async function readImageFiles(files: FileList): Promise<WorkflowImage[]> {
  const out: WorkflowImage[] = []
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${out.length}`
    out.push({ id, dataUrl })
  }
  return out
}

// ---- 输入图片节点 ----------------------------------------------------------

export const InputNodeView = memo(function InputNodeView({ id, data }: NodeProps<InputNode>) {
  const { updateNodeData } = useReactFlow()
  const inputRef = useRef<HTMLInputElement>(null)

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const added = await readImageFiles(files)
      updateNodeData(id, (node) => ({ images: [...(node.data as InputNode['data']).images, ...added] }))
    },
    [id, updateNodeData],
  )

  const removeAt = useCallback(
    (imgId: string) => updateNodeData(id, (node) => ({ images: (node.data as InputNode['data']).images.filter((i) => i.id !== imgId) })),
    [id, updateNodeData],
  )

  return (
    <NodeShell title={data.label} accent="#0ea5e9">
      {data.images.length > 0 ? (
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {data.images.map((img) => (
            <div key={img.id} className="group relative">
              <img src={img.dataUrl} alt="" className="aspect-square w-full rounded-md border border-[hsl(var(--border))] object-cover" />
              <button
                type="button"
                onClick={() => removeAt(img.id)}
                className="nodrag absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] text-white group-hover:flex"
                aria-label="移除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="nodrag w-full rounded-lg border border-dashed border-[hsl(var(--border))] py-2 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))]"
      >
        + 上传图片
      </button>
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
      <Handle type="source" position={Position.Right} id={HANDLE.OUT} className={HANDLE_CLASS} />
    </NodeShell>
  )
})

// ---- 提示词节点 ------------------------------------------------------------

export const TextNodeView = memo(function TextNodeView({ id, data }: NodeProps<TextNode>) {
  const { updateNodeData } = useReactFlow()
  return (
    <NodeShell title={data.label} accent="#8b5cf6">
      <textarea
        value={data.text}
        onChange={(e) => updateNodeData(id, { text: e.target.value })}
        placeholder="输入提示词…"
        rows={3}
        className="nodrag nowheel w-full resize-none rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))]"
      />
      <Handle type="source" position={Position.Right} id={HANDLE.OUT} className={HANDLE_CLASS} />
    </NodeShell>
  )
})

// ---- 生成节点 --------------------------------------------------------------

const SIZE_OPTIONS = ['auto', '1024x1024', '1024x1536', '1536x1024']
const QUALITY_OPTIONS: GenerateNode['data']['params']['quality'][] = ['auto', 'low', 'medium', 'high']

export const GenerateNodeView = memo(function GenerateNodeView({ id, data }: NodeProps<GenerateNode>) {
  const { updateNodeData } = useReactFlow()
  const setParam = useCallback(
    (patch: Partial<GenerateNode['data']['params']>) =>
      updateNodeData(id, (node) => ({ params: { ...(node.data as GenerateNode['data']).params, ...patch } })),
    [id, updateNodeData],
  )

  return (
    <NodeShell title={data.label} status={data.status}>
      {/* 端口标签:images(上) / prompt(下) */}
      <div className="relative">
        <Handle type="target" position={Position.Left} id={HANDLE.GEN_IMAGES} style={{ top: 8 }} className={HANDLE_CLASS} />
        <Handle type="target" position={Position.Left} id={HANDLE.GEN_PROMPT} style={{ top: 32 }} className="!h-3 !w-3 !border-2 !border-[hsl(var(--background))] !bg-violet-500" />
        <div className="mb-2 ml-1 space-y-0.5 text-[10px] leading-4 text-[hsl(var(--muted-foreground))]">
          <div>● 图片输入</div>
          <div>● 提示词输入(覆盖下方)</div>
        </div>
      </div>

      <textarea
        value={data.prompt}
        onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
        placeholder="内联提示词(未连提示词端口时生效)…"
        rows={3}
        className="nodrag nowheel mb-2 w-full resize-none rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))]"
      />

      <div className="mb-2 flex items-center gap-1.5">
        <select
          value={data.params.size}
          onChange={(e) => setParam({ size: e.target.value })}
          className="nodrag min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-1.5 py-1 text-[11px] text-[hsl(var(--foreground))] outline-none"
        >
          {SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === 'auto' ? '尺寸:自动' : s}</option>
          ))}
        </select>
        <select
          value={data.params.quality}
          onChange={(e) => setParam({ quality: e.target.value as GenerateNode['data']['params']['quality'] })}
          className="nodrag rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-1.5 py-1 text-[11px] text-[hsl(var(--foreground))] outline-none"
        >
          {QUALITY_OPTIONS.map((q) => (
            <option key={q} value={q}>{`质量:${q}`}</option>
          ))}
        </select>
      </div>

      {data.error && <div className="mb-2 rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">{data.error}</div>}
      <ImageGrid images={data.outputs} empty="运行后显示生成结果" downloadLabel={data.label} />
      {data.elapsedMs != null && data.status === 'done' && (
        <div className="mt-1 text-right text-[10px] text-[hsl(var(--muted-foreground))]">{(data.elapsedMs / 1000).toFixed(1)}s</div>
      )}

      <Handle type="source" position={Position.Right} id={HANDLE.OUT} className={HANDLE_CLASS} />
    </NodeShell>
  )
})

// ---- 输出节点 --------------------------------------------------------------

export const OutputNodeView = memo(function OutputNodeView({ data }: NodeProps<OutputNode>) {
  return (
    <NodeShell title={data.label} accent="#10b981">
      <Handle type="target" position={Position.Left} id={HANDLE.IN} className={HANDLE_CLASS} />
      {data.images.length > 0 && (
        <button
          type="button"
          onClick={() => downloadWorkflowImages(data.images, data.label)}
          className="nodrag mb-2 w-full rounded-lg border border-[hsl(var(--border))] py-1.5 text-xs text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
        >
          ↓ 下载全部({data.images.length})
        </button>
      )}
      <ImageGrid images={data.images} empty="汇总上游生成结果" downloadLabel={data.label} />
    </NodeShell>
  )
})

export const workflowNodeTypes = {
  input: InputNodeView,
  text: TextNodeView,
  generate: GenerateNodeView,
  output: OutputNodeView,
}
