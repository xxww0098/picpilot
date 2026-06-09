import { WrenchIcon } from '../icons'

const AGENT_STARTER_PROMPTS = [
  {
    id: 'marketplace-main',
    title: '生成一组商品主图',
    description: '白底、轻阴影、主体比例稳定',
    prompt: '为这个商品生成一组电商主图：纯净白底，主体居中，保留真实材质和结构，边缘清晰，光线柔和但有立体感。输出 4 个可比较版本，并说明每个版本适合的上架场景。',
  },
  {
    id: 'reference-variants',
    title: '基于参考图做变体',
    description: '保留主体，只变构图和场景',
    prompt: '基于我提供的参考图做同系列变体：保持商品主体、颜色和关键结构一致，只调整构图、背景和光线。请先判断参考图中的主体，再生成 4 个适合电商详情页的视觉方向。',
  },
  {
    id: 'repair-details',
    title: '修复细节并保持一致',
    description: '适合瑕疵、文字、边缘和材质',
    prompt: '检查参考图中的主体一致性、边缘、材质和文字细节，指出最需要修复的地方，然后生成修复版本。要求主体比例不变，材质真实，不新增无关元素。',
  },
  {
    id: 'detail-selling-points',
    title: '整理详情页卖点图',
    description: '把卖点拆成可出图轮次',
    prompt: '把这个商品整理成详情页卖点图方案：先列出 3 个最适合视觉化的卖点，再分别生成对应画面。每张图需要主体清楚、背景克制、适合电商详情页连续展示。',
  },
] as const

export default function AgentStarterPanel({
  label,
  title,
  description,
  onApplyPrompt,
}: {
  label: string
  title: string
  description: string
  onApplyPrompt: (prompt: string) => void
}) {
  return (
    <div className="mx-auto flex min-h-[46vh] w-full max-w-3xl flex-col justify-start px-4 pb-[calc(var(--input-bar-clearance,12rem)+2rem)] pt-2 sm:pt-4 lg:pt-5">
      <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
        <WrenchIcon className="h-4 w-4 text-blue-500" />
        {label}
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {AGENT_STARTER_PROMPTS.map((starter) => (
          <button
            key={starter.id}
            type="button"
            onClick={() => onApplyPrompt(starter.prompt)}
            className="min-h-[4.5rem] rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10"
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">{starter.title}</span>
            <span className="mt-1 block truncate text-xs leading-5 text-gray-500 dark:text-gray-400">{starter.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
