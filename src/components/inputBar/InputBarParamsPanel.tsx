import { dismissAllTooltips } from '../../lib/tooltipDismiss'
import { useHintTooltip } from '../../hooks/useHintTooltip'
import Select from '../Select'
import ButtonTooltip from './ButtonTooltip'
import type { TaskParams } from '../../types'

export type InputBarParamsPanelProps = {
  cols: string
  params: TaskParams
  setParams: (patch: Partial<TaskParams>) => void
  settings: { codexCli?: boolean }
  displaySize: string
  qualityOptions: { label: string; value: string }[]
  compressionDisabled: boolean
  agentAutoImageCount: boolean
  outputImageLimit: number
  nLimitHintText: string
  streamConcurrentByN: boolean
  outputCompressionInput: string
  setOutputCompressionInput: (value: string) => void
  commitOutputCompression: () => void
  nInput: string
  setNInputFocused: (focused: boolean) => void
  handleNInputChange: (value: string) => void
  commitN: () => void
  handleNLimitIncreaseAttempt: (preventDefault: () => void) => void
  showAgentNHint: () => void
  hideNLimitHint: () => void
  startAgentNHintTouch: () => void
  clearAgentNHintTouchTimer: () => void
  setShowSizePicker: (show: boolean) => void
  qualityHint: ReturnType<typeof useHintTooltip>
  compressionHint: ReturnType<typeof useHintTooltip>
  nLimitHint: ReturnType<typeof useHintTooltip>
}

export default function InputBarParamsPanel({
  cols,
  params,
  setParams,
  settings,
  displaySize,
  qualityOptions,
  compressionDisabled,
  agentAutoImageCount,
  outputImageLimit,
  nLimitHintText,
  streamConcurrentByN,
  outputCompressionInput,
  setOutputCompressionInput,
  commitOutputCompression,
  nInput,
  setNInputFocused,
  handleNInputChange,
  commitN,
  handleNLimitIncreaseAttempt,
  showAgentNHint,
  hideNLimitHint,
  startAgentNHintTouch,
  clearAgentNHintTouchTimer,
  setShowSizePicker,
  qualityHint,
  compressionHint,
  nLimitHint,
}: InputBarParamsPanelProps) {
  const selectClass = 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm'

  return (
    <div className={`grid ${cols} gap-2 text-xs flex-1`}>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">尺寸</span>
        <button
          type="button"
          onClick={() => { dismissAllTooltips(); setShowSizePicker(true) }}
          className="px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] focus:outline-none text-xs text-left transition-all duration-200 shadow-sm font-mono"
          title="选择尺寸"
        >
          {displaySize}
        </button>
      </label>
      <label
        className="relative flex flex-col gap-0.5"
        onMouseEnter={qualityHint.show}
        onMouseLeave={qualityHint.hide}
        onTouchStart={qualityHint.startTouch}
        onTouchEnd={qualityHint.clearTimer}
        onTouchCancel={qualityHint.hide}
        onClick={qualityHint.show}
      >
        <span className="text-gray-400 dark:text-gray-500 ml-1">质量</span>
        <Select
          value={settings.codexCli ? 'auto' : params.quality}
          onChange={(val) => {
            if (!settings.codexCli) setParams({ quality: val as any })
          }}
          options={qualityOptions}
          disabled={settings.codexCli}
          className={settings.codexCli
            ? 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed text-xs transition-all duration-200 shadow-sm'
            : selectClass}
        />
        <ButtonTooltip
          visible={Boolean(settings.codexCli) && qualityHint.visible}
          text="Codex CLI 不支持质量参数"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">格式</span>
        <Select
          value={params.output_format}
          onChange={(val) => setParams({ output_format: val as any })}
          options={[
            { label: 'PNG', value: 'png' },
            { label: 'JPEG', value: 'jpeg' },
            { label: 'WebP', value: 'webp' },
          ]}
          className={selectClass}
        />
      </label>
      <label
        className="relative flex flex-col gap-0.5"
        onMouseEnter={compressionHint.show}
        onMouseLeave={compressionHint.hide}
        onTouchStart={compressionHint.startTouch}
        onTouchEnd={compressionHint.clearTimer}
        onTouchCancel={compressionHint.hide}
        onClick={compressionHint.show}
      >
        <span className="text-gray-400 dark:text-gray-500 ml-1">压缩率</span>
        <input
          value={outputCompressionInput}
          onChange={(e) => setOutputCompressionInput(e.target.value)}
          onBlur={commitOutputCompression}
          disabled={compressionDisabled}
          type="number"
          min={0}
          max={100}
          placeholder="0-100"
          className={`px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] focus:outline-none text-xs transition-all duration-200 shadow-sm ${
            compressionDisabled
              ? 'bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed'
              : 'bg-white/50 dark:bg-white/[0.03]'
            }`}
        />
        <ButtonTooltip
          visible={compressionHint.visible}
          text="仅 JPEG 和 WebP 支持压缩率"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">审核</span>
        <Select
          value={params.moderation}
          onChange={(val) => setParams({ moderation: val as any })}
          options={[
            { label: '自动', value: 'auto' },
            { label: '低强度', value: 'low' },
          ]}
          className={selectClass}
        />
      </label>
      <label
        className="relative flex flex-col gap-0.5"
        onMouseEnter={showAgentNHint}
        onMouseLeave={hideNLimitHint}
        onTouchStart={startAgentNHintTouch}
        onTouchEnd={clearAgentNHintTouchTimer}
        onTouchCancel={() => {
          clearAgentNHintTouchTimer()
          hideNLimitHint()
        }}
        onClick={showAgentNHint}
      >
        <span className="text-gray-400 dark:text-gray-500 ml-1">数量</span>
        <input
          value={nInput}
          onChange={(e) => handleNInputChange(e.target.value)}
          onFocus={() => setNInputFocused(true)}
          onBlur={() => {
            setNInputFocused(false)
            commitN()
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              handleNLimitIncreaseAttempt(() => e.preventDefault())
            }
          }}
          onWheel={(e) => {
            if (e.deltaY < 0) {
              handleNLimitIncreaseAttempt(() => e.preventDefault())
            }
          }}
          disabled={agentAutoImageCount}
          type={agentAutoImageCount ? 'text' : 'number'}
          min={agentAutoImageCount ? undefined : 1}
          max={agentAutoImageCount ? undefined : outputImageLimit}
          className={`px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] focus:outline-none text-xs transition-all duration-200 shadow-sm ${
            agentAutoImageCount
              ? 'bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed'
              : 'bg-white/50 dark:bg-white/[0.03]'
          }`}
        />
        <ButtonTooltip visible={nLimitHint.visible} text={nLimitHintText} />
        <ButtonTooltip visible={streamConcurrentByN && !nLimitHint.visible} text="数量大于 1 时会将多图生成拆分为并发单图" />
      </label>
    </div>
  )
}
