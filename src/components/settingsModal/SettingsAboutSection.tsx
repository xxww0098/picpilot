// 「关于」设置页（由 SettingsModal 抽出，纯展示，无 props）。
export default function SettingsAboutSection() {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center pb-8 px-6">
      <div className="flex flex-col items-center">
        <div className="mb-5 flex h-[88px] w-[88px] items-center justify-center rounded-full border border-gray-200/80 bg-gray-50/50 text-gray-800 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-100">
          <svg className="h-11 w-11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        </div>
        <h4 className="text-[17px] font-bold text-gray-800 dark:text-gray-100">picpilot</h4>
        <p className="mt-1.5 text-[13px] text-gray-500 dark:text-gray-400">v{__APP_VERSION__}</p>
      </div>
    </div>
  )
}
