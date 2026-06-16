import { useEffect, useState } from 'react'
import { ensureImageCached, getCachedImage } from '../../store'
import { runWithConcurrency } from '../../lib/shared/runWithConcurrency'
import { createMaskPreviewDataUrl } from '../../lib/imaging/canvasImage'
import { getVideo } from '../../lib/shared/db'
import type { TaskRecord } from '../../types'
import { IMAGE_DECODE_CONCURRENCY } from './constants'

/** 详情弹窗的媒体资源装载：输入/输出图、视频、遮罩预览的解码与缓存状态。 */
export function useDetailModalMedia(task: TaskRecord | null, isVideoTask: boolean, imageIndex: number) {
  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})
  const [outputPreviewSrcs, setOutputPreviewSrcs] = useState<Record<string, string>>({})
  const [imageRatios, setImageRatios] = useState<Record<string, string>>({})
  const [imageSizes, setImageSizes] = useState<Record<string, string>>({})
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')
  const [videoSrc, setVideoSrc] = useState('')
  const [videoPosterSrc, setVideoPosterSrc] = useState('')

  // 加载所有相关图片
  useEffect(() => {
    if (!task) {
      setImageSrcs({})
      setOutputPreviewSrcs({})
      setImageRatios({})
      setImageSizes({})
      return
    }

    let cancelled = false
    const ids = [...new Set([
      ...(task.inputImageIds || []),
      ...(task.maskImageId ? [task.maskImageId] : []),
    ])]
    const initial: Record<string, string> = {}
    for (const id of ids) {
      const cached = getCachedImage(id)
      if (cached) initial[id] = cached
    }
    setImageSrcs(initial)
    const pending = ids.filter((id) => !initial[id])
    void runWithConcurrency(pending, IMAGE_DECODE_CONCURRENCY, async (id) => {
      const url = await ensureImageCached(id)
      if (!cancelled && url) setImageSrcs((prev) => ({ ...prev, [id]: url }))
    })

    return () => {
      cancelled = true
    }
  }, [task])

  const currentOutputImageId = task?.outputImages?.[imageIndex] || ''
  const currentOutputVideoId = task?.outputVideos?.[imageIndex] || ''
  const currentOutputPreviewSrc = currentOutputImageId ? outputPreviewSrcs[currentOutputImageId] || '' : ''
  const maskTargetId = task?.maskTargetImageId || null
  const maskTargetSrc = maskTargetId ? imageSrcs[maskTargetId] || '' : ''
  const maskSrc = task?.maskImageId ? imageSrcs[task.maskImageId] || '' : ''
  const allInputImageIds = task?.inputImageIds ?? []

  useEffect(() => {
    const outputImageIds = task?.outputImages ?? []
    if (outputImageIds.length === 0) {
      setOutputPreviewSrcs({})
      return
    }

    let cancelled = false
    const setOutputImage = (imageId: string, dataUrl: string) => {
      if (!cancelled) setOutputPreviewSrcs((prev) => ({ ...prev, [imageId]: dataUrl }))
    }

    const pending: string[] = []
    for (const imageId of outputImageIds) {
      const cached = getCachedImage(imageId)
      if (cached) setOutputImage(imageId, cached)
      else pending.push(imageId)
    }
    void runWithConcurrency(pending, IMAGE_DECODE_CONCURRENCY, async (imageId) => {
      const dataUrl = await ensureImageCached(imageId)
      if (dataUrl) setOutputImage(imageId, dataUrl)
    })

    return () => {
      cancelled = true
    }
  }, [task?.outputImages])

  useEffect(() => {
    setVideoSrc('')
    setVideoPosterSrc('')
    if (!isVideoTask || !currentOutputVideoId) return

    let cancelled = false
    let objectUrl = ''
    getVideo(currentOutputVideoId).then((video) => {
      if (cancelled || !video) return
      if (video.blob) {
        objectUrl = URL.createObjectURL(video.blob)
        setVideoSrc(objectUrl)
      } else if (video.remoteUrl) {
        setVideoSrc(video.remoteUrl)
      }
      setVideoPosterSrc(video.posterDataUrl || '')
    }).catch(() => {
      if (!cancelled) setVideoSrc('')
    })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [currentOutputVideoId, isVideoTask])

  useEffect(() => {
    let cancelled = false
    setMaskPreviewSrc('')
    if (!maskTargetSrc || !maskSrc) return

    createMaskPreviewDataUrl(maskTargetSrc, maskSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [maskTargetSrc, maskSrc])

  return {
    imageSrcs,
    imageRatios,
    setImageRatios,
    imageSizes,
    setImageSizes,
    maskPreviewSrc,
    videoSrc,
    videoPosterSrc,
    currentOutputImageId,
    currentOutputPreviewSrc,
    maskTargetId,
    allInputImageIds,
  }
}
