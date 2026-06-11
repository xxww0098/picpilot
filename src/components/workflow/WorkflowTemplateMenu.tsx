import { useMemo } from 'react'
import type { WorkflowTemplate } from '../../lib/workflow/templates'

function getTemplateStats(template: WorkflowTemplate) {
  const graph = template.build()
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    generates: graph.nodes.filter((node) => node.data.kind === 'generate').length,
  }
}

function getTemplateLabel(template: WorkflowTemplate) {
  if (template.platform !== '通用') return template.platform
  if (template.id.includes('try-on')) return '服装海报'
  if (template.id.includes('video')) return '视频分镜'
  return '工作流模板'
}

export default function WorkflowTemplateMenu({
  templates,
  onSelect,
}: {
  templates: WorkflowTemplate[]
  onSelect: (template: WorkflowTemplate) => void
}) {
  const statsById = useMemo(
    () => Object.fromEntries(templates.map((template) => [template.id, getTemplateStats(template)])),
    [templates],
  )

  return (
    <div
      role="menu"
      className="animate-dropdown-down absolute bottom-full left-0 z-20 mb-2 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2 shadow-lg"
    >
      <div className="px-2 pb-2 pt-1">
        <div className="text-sm font-semibold text-[hsl(var(--foreground))]">模板库</div>
        <div className="mt-0.5 text-xs leading-5 text-[hsl(var(--muted-foreground))]">选择一个成熟流程，自动铺好节点、连线和提示词。</div>
      </div>
      <div className="grid gap-2">
        {templates.map((template) => {
          const stats = statsById[template.id]
          return (
            <button
              key={template.id}
              type="button"
              role="menuitem"
              onClick={() => onSelect(template)}
              className="group rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-3 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40 dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10"
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[hsl(var(--foreground))]">{template.name}</span>
                    <span className="shrink-0 rounded-md bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[11px] font-medium text-[hsl(var(--muted-foreground))]">{getTemplateLabel(template)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[hsl(var(--muted-foreground))]">{template.description}</p>
                </div>
                <span className="shrink-0 text-lg leading-none text-[hsl(var(--muted-foreground))] transition-transform group-hover:translate-x-0.5">›</span>
              </div>
              {stats && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                  <span className="rounded-md bg-[hsl(var(--muted))] px-1.5 py-0.5">{stats.nodes} 节点</span>
                  <span className="rounded-md bg-[hsl(var(--muted))] px-1.5 py-0.5">{stats.edges} 连线</span>
                  <span className="rounded-md bg-[hsl(var(--muted))] px-1.5 py-0.5">{stats.generates} 生成节点</span>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
