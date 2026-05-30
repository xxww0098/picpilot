import Select from '../Select'
import type { AppSettings } from '../../types'

// 「通用」设置页：纯展示 + 通过 commitSettings 写回，无私有状态（由 SettingsModal 抽出，结构等价）。
export default function SettingsGeneralSection({
  draft,
  commitSettings,
}: {
  draft: AppSettings
  commitSettings: (next: AppSettings) => void
}) {
  return (
    <div className="space-y-4">
      <div className="hidden sm:block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">任务提交方式</span>
          <div className="w-32">
            <Select
              value={draft.enterSubmit ? 'enter' : 'ctrl-enter'}
              onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
              options={[
                { label: 'Enter', value: 'enter' },
                { label: navigator.userAgent.includes('Mac') ? 'Cmd + Enter' : 'Ctrl + Enter', value: 'ctrl-enter' }
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          选择 Enter 提交时，使用 Shift + Enter 换行；否则直接 Enter 换行。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">提交任务后清空输入框</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, clearInputAfterSubmit: !draft.clearInputAfterSubmit })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.clearInputAfterSubmit ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.clearInputAfterSubmit}
            aria-label="提交任务后清空输入框"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.clearInputAfterSubmit ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，提交成功创建任务时会清空提示词和参考图。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">参考图编辑按钮</span>
          <div className="w-32">
            <Select
              value={draft.referenceImageEditAction}
              onChange={(val) => commitSettings({ ...draft, referenceImageEditAction: val as AppSettings['referenceImageEditAction'] })}
              options={[
                { label: '询问', value: 'ask' },
                { label: '替换参考图', value: 'replace-reference' },
                { label: '添加遮罩', value: 'add-mask' },
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          控制未添加遮罩的参考图点击编辑按钮时，是每次询问、直接替换参考图，还是直接添加遮罩。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">重启后加载上次的输入框</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, persistInputOnRestart: !draft.persistInputOnRestart })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.persistInputOnRestart ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.persistInputOnRestart}
            aria-label="重启后加载上次的输入框"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.persistInputOnRestart ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          关闭后，不再持久化提示词和参考图，下次启动会使用空输入框。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
        <span className="block text-sm text-gray-600 dark:text-gray-300">复用历史任务时使用原 API 与模型配置</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, reuseTaskApiProfileTemporarily: !draft.reuseTaskApiProfileTemporarily })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.reuseTaskApiProfileTemporarily ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.reuseTaskApiProfileTemporarily}
            aria-label="复用历史任务时使用原 API 与模型配置"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.reuseTaskApiProfileTemporarily ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，复用历史任务时会先尝试使用当时的 API 与模型配置；如果配置已删除，提交前会询问是否改用当前配置。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">成功任务也显示重试按钮</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, alwaysShowRetryButton: !draft.alwaysShowRetryButton })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.alwaysShowRetryButton ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.alwaysShowRetryButton}
            aria-label="成功任务也显示重试按钮"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.alwaysShowRetryButton ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，已成功的任务卡片和详情页也会显示重试按钮，方便用相同参数再生成一次。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">发送消息后自动滚动到底部</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, agentScrollToBottomAfterSubmit: !draft.agentScrollToBottomAfterSubmit })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.agentScrollToBottomAfterSubmit ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentScrollToBottomAfterSubmit}
            aria-label="发送消息后自动滚动到底部"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentScrollToBottomAfterSubmit ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，在 Agent 模式发送消息成功后会自动滚动到对话底部。
        </div>
      </div>
    </div>
  )
}
