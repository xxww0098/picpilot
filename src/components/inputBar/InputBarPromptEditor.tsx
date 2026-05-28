import { CloseIcon } from '../icons'
import { AtImageOptionThumb, type AtImageOption } from './atImageOptions'
import type { useInputBarPromptEditor } from './useInputBarPromptEditor'

export type InputBarPromptEditorProps = Pick<
  ReturnType<typeof useInputBarPromptEditor>,
  | 'textareaRef'
  | 'isSingleLine'
  | 'promptPlaceholder'
  | 'showAtImageMenu'
  | 'atImageOptions'
  | 'atImageMenuIndex'
  | 'menuLeft'
  | 'setAtImageMenuIndex'
  | 'selectAtImageOption'
  | 'handleKeyDown'
  | 'handlePromptPaste'
  | 'handlePromptCopy'
  | 'handleClearPrompt'
  | 'handlePromptInput'
  | 'handlePromptSelect'
  | 'handlePromptClick'
> & {
  prompt: string
}

export default function InputBarPromptEditor({
  prompt,
  textareaRef,
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
}: InputBarPromptEditorProps) {
  return (
    <div className="relative grid">
      {showAtImageMenu && (
        <div style={{ left: `${menuLeft}px` }} className="absolute bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
          <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">选择图片引用</div>
          <div className="max-h-56 overflow-y-auto custom-scrollbar">
            {atImageOptions.map((option: AtImageOption, optionIndex: number) => (
              <button
                key={option.key}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectAtImageOption(option)
                }}
                onMouseEnter={() => setAtImageMenuIndex(optionIndex)}
                className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${
                  optionIndex === atImageMenuIndex
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                }`}
              >
                <AtImageOptionThumb option={option} />
                <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                {option.type === 'agent-output' && (
                  <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">历史</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        ref={textareaRef}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => handlePromptInput(e.currentTarget)}
        onSelect={(e) => handlePromptSelect(e.currentTarget)}
        onKeyDown={handleKeyDown}
        onPaste={handlePromptPaste}
        onCopy={handlePromptCopy}
        onClick={handlePromptClick}
        aria-label={promptPlaceholder}
        className="col-start-1 row-start-1 min-h-[42px] w-full overflow-hidden ios-rounded-scroll-fix whitespace-pre-wrap break-words rounded-2xl border border-gray-200/60 bg-white/50 pl-4 pr-10 py-3 text-sm leading-relaxed shadow-sm outline-none transition-[border-color,box-shadow] duration-200 focus:ring-1 focus:ring-blue-300/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100 dark:focus:ring-blue-500/30"
      />
      {prompt.length === 0 && (
        <div className="prompt-placeholder col-start-1 row-start-1 pointer-events-none pl-4 pr-10 py-3 text-sm leading-relaxed text-gray-400 dark:text-gray-500">
          {promptPlaceholder}
        </div>
      )}
      {prompt.length > 0 && (
        <button
          type="button"
          onClick={handleClearPrompt}
          className={`absolute right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.08] rounded-full p-1 transition-all duration-200 focus:outline-none z-10 flex items-center justify-center ${
            isSingleLine ? 'top-1/2 -translate-y-1/2' : 'top-3'
          }`}
          title="清空文本"
        >
          <CloseIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
