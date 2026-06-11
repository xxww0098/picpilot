export type TaskStreamPreviewSlots = Record<string, string> | undefined

export type TaskStreamPreviewItem = {
  index: number
  src: string
}

export type TaskStreamPreviewOptions = {
  taskOutputCount?: number | null
  streamPreviewSrc?: string
  streamPreviewSlots?: TaskStreamPreviewSlots
}

function getStableOutputCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

function getSlotEntries(streamPreviewSlots: TaskStreamPreviewSlots): Array<[number, string]> {
  if (!streamPreviewSlots) return []
  return Object.entries(streamPreviewSlots)
    .map(([key, src]) => [Number(key), src] as [number, string])
    .filter(([index]) => Number.isInteger(index) && index >= 0)
    .sort(([a], [b]) => a - b)
}

export function getTaskStreamPreviewItems({
  taskOutputCount,
  streamPreviewSrc = '',
  streamPreviewSlots,
}: TaskStreamPreviewOptions): TaskStreamPreviewItem[] {
  const slotEntries = getSlotEntries(streamPreviewSlots)
  const highestSlotCount = slotEntries.length ? Math.max(...slotEntries.map(([index]) => index + 1)) : 0
  const count = Math.max(getStableOutputCount(taskOutputCount), highestSlotCount, streamPreviewSrc ? 1 : 0)
  if (count === 0) return []

  const byIndex = new Map(slotEntries)
  return Array.from({ length: count }, (_, index) => ({
    index,
    src: byIndex.has(index) ? byIndex.get(index) || '' : index === 0 ? streamPreviewSrc : '',
  }))
}

export function getTaskStreamPreviewSummary(options: TaskStreamPreviewOptions): {
  received: number
  total: number
  primarySrc: string
} {
  const items = getTaskStreamPreviewItems(options)
  const nonEmptyItems = items.filter((item) => Boolean(item.src))
  const slottedPreviewCount = getSlotEntries(options.streamPreviewSlots).filter(([, src]) => Boolean(src)).length
  const received = slottedPreviewCount > 0 ? slottedPreviewCount : options.streamPreviewSrc ? 1 : 0
  return {
    received,
    total: items.length,
    primarySrc: nonEmptyItems.length ? nonEmptyItems[nonEmptyItems.length - 1].src : options.streamPreviewSrc || '',
  }
}
