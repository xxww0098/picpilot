import { ChevronDownIcon } from '../ui/icons'

export default function AgentMobilePullIndicator({
  pullDownOffset,
  hidden,
  maxOffset,
}: {
  pullDownOffset: number
  hidden: boolean
  maxOffset: number
}) {
  if (pullDownOffset <= 0 || hidden) return null

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex justify-center items-end pointer-events-none sm:hidden"
      style={{ height: `${pullDownOffset + 10}px`, opacity: pullDownOffset / maxOffset }}
    >
      <div className="bg-black/60 backdrop-blur-sm text-white rounded-full p-1 mb-2 shadow-lg">
        <ChevronDownIcon className="w-4 h-4" />
      </div>
    </div>
  )
}
