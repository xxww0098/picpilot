import type { TaskImageSource, TaskRecord, UpstreamMode } from '../types'

export function getUpstreamModeLabel(mode: UpstreamMode | null | undefined): string {
  if (mode === 'api') return 'API'
  if (mode === 'reverse') return '逆向'
  if (mode === 'server') return '服务端默认'
  return ''
}

export function getTaskImageSource(task: TaskRecord, imageId: string | null | undefined): TaskImageSource {
  const perImage = imageId ? task.sourceByImage?.[imageId] : undefined
  return {
    apiProvider: perImage?.apiProvider ?? task.apiProvider,
    apiProfileId: perImage?.apiProfileId ?? task.apiProfileId,
    apiProfileName: perImage?.apiProfileName ?? task.apiProfileName,
    apiMode: perImage?.apiMode ?? task.apiMode,
    apiModel: perImage?.apiModel ?? task.apiModel,
    upstreamMode: perImage?.upstreamMode ?? task.upstreamMode,
  }
}

export function getTaskFailedImageSource(task: TaskRecord): TaskImageSource {
  const failedSource = task.failedImageSource
  return {
    apiProvider: failedSource?.apiProvider ?? task.apiProvider,
    apiProfileId: failedSource?.apiProfileId ?? task.apiProfileId,
    apiProfileName: failedSource?.apiProfileName ?? task.apiProfileName,
    apiMode: failedSource?.apiMode ?? task.apiMode,
    apiModel: failedSource?.apiModel ?? task.apiModel,
    upstreamMode: failedSource?.upstreamMode ?? task.upstreamMode,
  }
}

export function hasMixedTaskImageSources(task: TaskRecord): boolean {
  const sources = task.outputImages.map((imageId) => getTaskImageSource(task, imageId))
  if ((task.failedImageCount ?? 0) > 0) sources.push(getTaskFailedImageSource(task))
  if (!sources.length) return false
  const keys = new Set(sources.map(taskImageSourceKey))
  return keys.size > 1
}

function taskImageSourceKey(source: TaskImageSource): string {
  return [
    source.apiProvider ?? '',
    source.apiProfileId ?? '',
    source.apiProfileName ?? '',
    source.apiMode ?? '',
    source.apiModel ?? '',
    source.upstreamMode ?? '',
  ].join('|')
}
