import { useStore } from '../store'
import ModalShell from './ModalShell'
import { CloseIcon } from './icons'

export default function SupportPromptModal() {
  const supportPromptOpen = useStore((s) => s.supportPromptOpen)
  const dismissSupportPrompt = useStore((s) => s.dismissSupportPrompt)
  const confirmDialog = useStore((s) => s.confirmDialog)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const showSettings = useStore((s) => s.showSettings)
  const maskEditorImageId = useStore((s) => s.maskEditorImageId)

  const blockedByHigherPriorityModal = Boolean(
    confirmDialog || detailTaskId || lightboxImageId || showSettings || maskEditorImageId,
  )
  const visible = supportPromptOpen && !blockedByHigherPriorityModal

  if (!visible) return null

  return (
    <ModalShell
      portal
      onClose={dismissSupportPrompt}
      zIndexClass="z-[70]"
      panelClassName="w-full max-w-sm rounded-[2rem] border border-white/50 bg-white/95 p-6 pb-7 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex flex-col"
    >
        <div className="absolute right-4 top-4">
          <button
            type="button"
            onClick={dismissSupportPrompt}
            className="rounded-full p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 mt-4 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-[1.5rem] bg-[#f4f0ff] text-[#946ce6] dark:bg-[#946ce6]/10 dark:text-[#bba3f2]">
            <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
        </div>

        <h3 className="mb-3 text-center text-xl font-bold text-gray-800 dark:text-gray-100">
          感谢使用 🎉
        </h3>

        <p className="mb-8 px-2 text-center text-[15px] leading-relaxed text-gray-500 dark:text-gray-400">
          你已经成功生成了超过 <strong className="font-semibold text-gray-800 dark:text-gray-200">50</strong> 张图片！
        </p>

        <div className="flex items-center justify-center">
          <button
            type="button"
            onClick={dismissSupportPrompt}
            className="flex items-center justify-center gap-2 rounded-2xl bg-[#f4f4f5] px-8 py-3.5 text-[15px] font-semibold text-gray-600 transition-all hover:bg-gray-200 active:scale-[0.98] dark:bg-[#27272a] dark:text-gray-300 dark:hover:bg-[#3f3f46]"
          >
            继续使用
          </button>
        </div>
    </ModalShell>
  )
}
