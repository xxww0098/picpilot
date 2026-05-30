import type { AppSettings } from '../../types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS } from '../../types'
import { normalizeAgentMaxToolRounds } from '../../lib/apiProfiles'

// 「Agent」设置页（由 SettingsModal 抽出，结构等价；状态仍由父组件持有并透传）。
export default function SettingsAgentSection({
  draft,
  commitSettings,
  agentMaxToolRoundsInput,
  setAgentMaxToolRoundsInput,
  commitAgentMaxToolRounds,
}: {
  draft: AppSettings
  commitSettings: (next: AppSettings) => void
  agentMaxToolRoundsInput: string
  setAgentMaxToolRoundsInput: (value: string) => void
  commitAgentMaxToolRounds: () => void
}) {
  return (
    <div className="space-y-4">
      <label className="block">
      <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">Agent 最大连续工具轮数</span>
        <input
          value={agentMaxToolRoundsInput}
          onChange={(e) => setAgentMaxToolRoundsInput(e.target.value)}
          onBlur={commitAgentMaxToolRounds}
          type="number"
          min={1}
          max={50}
          className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        <div data-selectable-text className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          默认 15。用于限制 Agent 连续调用工具的轮数，避免长时间循环消耗额度。
        </div>
      </label>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">允许 Agent 网络搜索</span>
          <button
            type="button"
            onClick={() => {
              const agentMaxToolRounds = agentMaxToolRoundsInput.trim() === ''
                ? DEFAULT_AGENT_MAX_TOOL_ROUNDS
                : normalizeAgentMaxToolRounds(agentMaxToolRoundsInput, draft.agentMaxToolRounds)
              setAgentMaxToolRoundsInput(String(agentMaxToolRounds))
              commitSettings({ ...draft, agentMaxToolRounds, agentWebSearch: !draft.agentWebSearch })
            }}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${draft.agentWebSearch ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentWebSearch}
            aria-label="允许 Agent 网络搜索"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentWebSearch ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          启用 Responses API 的 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">web_search</code> 工具。模型每次调用该工具都会产生额外计费。
        </div>
      </div>
    </div>
  )
}
