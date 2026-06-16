import type { ExportData } from '../types'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  getAllImages,
  getAllTasks,
  getAllVideos,
  getImageThumbnail,
  putImage,
  putImageThumbnail,
  putVideo as dbPutVideo,
} from '../lib/shared/db'
import {
  getPersistableAgentConversations,
  isEmptyAgentConversation,
  mergeImportedAgentConversations,
  normalizeAgentConversations,
} from '../lib/agent/agentPersistence'
import { mergeImportedSettings } from '../lib/shared/apiProfiles'
import { bytesToDataUrl, dataUrlToBytes, formatExportFileTime } from '../lib/imaging/exportZip'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import { putTask } from '../lib/agent/taskPersistence'
import { cacheImage, cacheThumbnail, scheduleThumbnailBackfill } from './imageCache'
import { useStore } from './coreStore'
import { replaceStoredAgentConversations } from './persistence'

function uint8ToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const tasks = options.exportTasks ? await getAllTasks() : []
    const images = options.exportTasks ? await getAllImages() : []
    const videos = options.exportTasks ? await getAllVideos() : []
    const { settings, agentConversations } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()
    const videoCreatedAtFallback = new Map<string, number>()

    if (options.exportTasks) {
      for (const task of tasks) {
        for (const id of [
          ...(task.inputImageIds || []),
          ...(task.maskImageId ? [task.maskImageId] : []),
          ...(task.outputImages || []),
          ...(task.streamPartialImageIds || []),
        ]) {
          const prev = imageCreatedAtFallback.get(id)
          if (prev == null || task.createdAt < prev) {
            imageCreatedAtFallback.set(id, task.createdAt)
          }
        }
        for (const id of task.outputVideos || []) {
          const prev = videoCreatedAtFallback.get(id)
          if (prev == null || task.createdAt < prev) {
            videoCreatedAtFallback.set(id, task.createdAt)
          }
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
    const videoFiles: NonNullable<ExportData['videoFiles']> = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    if (options.exportTasks) {
      for (const img of images) {
        const { ext, bytes } = dataUrlToBytes(img.dataUrl)
        const path = `images/${img.id}.${ext}`
        const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
        imageFiles[img.id] = {
          path,
          createdAt,
          source: img.source,
          width: img.width,
          height: img.height,
        }
        zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]

        const thumbnail = await getImageThumbnail(img.id)
        if (thumbnail?.thumbnailDataUrl) {
          const { ext: thumbnailExt, bytes: thumbnailBytes } = dataUrlToBytes(thumbnail.thumbnailDataUrl)
          const thumbnailPath = `thumbnails/${img.id}.${thumbnailExt}`
          imageFiles[img.id].width = imageFiles[img.id].width ?? thumbnail.width
          imageFiles[img.id].height = imageFiles[img.id].height ?? thumbnail.height
          thumbnailFiles[img.id] = {
            path: thumbnailPath,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          }
          zipFiles[thumbnailPath] = [thumbnailBytes, { mtime: new Date(createdAt) }]
          cacheThumbnail(img.id, {
            dataUrl: thumbnail.thumbnailDataUrl,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          })
        }
      }

      for (const video of videos) {
        const createdAt = video.createdAt ?? videoCreatedAtFallback.get(video.id) ?? exportedAt
        const entry: NonNullable<ExportData['videoFiles']>[string] = {
          remoteUrl: video.remoteUrl,
          mime: video.mime,
          durationSeconds: video.durationSeconds,
          createdAt,
          source: video.source,
        }
        if (video.blob) {
          const ext = (video.mime?.split('/')[1] || 'mp4').replace(/[^a-z0-9]+/gi, '') || 'mp4'
          const path = `videos/${video.id}.${ext}`
          entry.path = path
          zipFiles[path] = [new Uint8Array(await video.blob.arrayBuffer()), { mtime: new Date(createdAt) }]
        }
        if (video.posterDataUrl) {
          const { ext, bytes } = dataUrlToBytes(video.posterDataUrl)
          const posterPath = `video-posters/${video.id}.${ext}`
          entry.posterPath = posterPath
          zipFiles[posterPath] = [bytes, { mtime: new Date(createdAt) }]
        }
        videoFiles[video.id] = entry
      }
    }

    const manifest: ExportData = {
      version: 3,
      exportedAt: new Date(exportedAt).toISOString(),
    }

    if (options.exportConfig) manifest.settings = settings
    if (options.exportTasks) {
      manifest.tasks = tasks
      manifest.agentConversations = getPersistableAgentConversations(agentConversations)
      manifest.imageFiles = imageFiles
      manifest.thumbnailFiles = thumbnailFiles
      manifest.videoFiles = videoFiles
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `picpilot-backup_${formatExportFileTime(new Date(exportedAt))}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${getUserFacingErrorMessage(e, '无法生成备份文件')}`,
        'error',
      )
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

/** 导入 ZIP 数据 */
export async function importData(file: File, options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))

    const importedImageIds: string[] = []
    if (options.importTasks && data.tasks && data.imageFiles) {
      // 还原图片
      for (const [id, info] of Object.entries(data.imageFiles)) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const dataUrl = bytesToDataUrl(bytes, info.path)
        await putImage({
          id,
          dataUrl,
          createdAt: info.createdAt,
          source: info.source,
          width: info.width,
          height: info.height,
        })
        cacheImage(id, dataUrl)
        importedImageIds.push(id)
      }

      for (const [id, info] of Object.entries(data.thumbnailFiles ?? {})) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const thumbnailDataUrl = bytesToDataUrl(bytes, info.path)
        await putImageThumbnail({
          id,
          thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
        cacheThumbnail(id, {
          dataUrl: thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
      }

      for (const [id, info] of Object.entries(data.videoFiles ?? {})) {
        const bytes = info.path ? unzipped[info.path] : undefined
        const posterBytes = info.posterPath ? unzipped[info.posterPath] : undefined
        await dbPutVideo({
          id,
          blob: bytes ? new Blob([uint8ToArrayBuffer(bytes)], { type: info.mime || 'video/mp4' }) : undefined,
          remoteUrl: info.remoteUrl,
          mime: info.mime,
          posterDataUrl: posterBytes && info.posterPath ? bytesToDataUrl(posterBytes, info.posterPath) : undefined,
          durationSeconds: info.durationSeconds,
          createdAt: info.createdAt,
          source: info.source,
        })
      }

      for (const task of data.tasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      useStore.getState().setTasks(tasks)
      const importedAgentConversations = normalizeAgentConversations(data.agentConversations)
        .filter((conversation) => !isEmptyAgentConversation(conversation))
      useStore.setState((state) => {
        const agentConversations = mergeImportedAgentConversations(state.agentConversations, importedAgentConversations)
        const activeAgentConversationId = state.activeAgentConversationId && agentConversations.some((conversation) => conversation.id === state.activeAgentConversationId)
          ? state.activeAgentConversationId
          : importedAgentConversations[0]?.id ?? agentConversations[0]?.id ?? null
        return {
          agentConversations,
          activeAgentConversationId,
        }
      })
      await replaceStoredAgentConversations(useStore.getState().agentConversations)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && data.settings) {
      const state = useStore.getState()
      state.setSettings(mergeImportedSettings(state.settings, data.settings))
    }

    let msg = '数据已成功导入'
    if (options.importTasks && data.tasks) {
      msg = `已导入 ${data.tasks.length} 条记录`
    } else if (options.importConfig && data.settings) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${getUserFacingErrorMessage(e, '备份文件无法读取')}`,
        'error',
      )
    return false
  }
}
