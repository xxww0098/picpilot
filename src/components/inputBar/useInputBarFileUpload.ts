import { useCallback, useRef } from 'react'
import { addImageFromFile, useStore } from '../../store'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'
import { API_MAX_IMAGES } from './constants'

export function useInputBarFileUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    try {
      const currentCount = useStore.getState().inputImages.length
      if (currentCount >= API_MAX_IMAGES) {
        useStore.getState().showToast(
          `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`,
          'error',
        )
        return
      }

      const remaining = API_MAX_IMAGES - currentCount
      const accepted = Array.from(files).filter((f) => f.type.startsWith('image/'))
      const toAdd = accepted.slice(0, remaining)
      const discarded = accepted.length - toAdd.length

      for (const file of toAdd) {
        await addImageFromFile(file)
      }

      if (discarded > 0) {
        useStore.getState().showToast(
          `已达上限 ${API_MAX_IMAGES} 张，${discarded} 张图片被丢弃`,
          'error',
        )
      }
    } catch (err) {
      useStore.getState().showToast(
        `图片添加失败：${getUserFacingErrorMessage(err, '请确认文件是有效图片')}`,
        'error',
      )
    }
  }, [])

  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFilesRef.current(e.target.files || [])
    e.target.value = ''
  }, [])

  return {
    fileInputRef,
    cameraInputRef,
    handleFilesRef,
    handleFileUpload,
  }
}
