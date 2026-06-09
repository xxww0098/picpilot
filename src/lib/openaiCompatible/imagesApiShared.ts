import type { ImageApiResponse, ImageResponseItem } from '../../types'
import {
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  normalizeBase64Image,
  pickActualParams,
} from '../imageApiShared'
import {
  getNumberValue,
  getStringValue,
  isRecordValue,
  normalizeImageApiPayload,
  readJsonServerSentEvents,
} from './shared'

export async function parseImagesApiResponse(payload: ImageApiResponse, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error('接口没有返回图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  try {
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }

      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const actualParams = mergeActualParams(
    pickActualParams(payload),
  )
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function getImageValueFields(source: Record<string, unknown>): Pick<ImageResponseItem, 'b64_json' | 'url'> {
  const explicitB64 = getStringValue(source, 'b64_json') ?? getStringValue(source, 'base64')
  if (explicitB64) return { b64_json: explicitB64 }

  const explicitUrl = getStringValue(source, 'url') ?? getStringValue(source, 'image_url')
  if (explicitUrl) return { url: explicitUrl }

  const image = getStringValue(source, 'image')
  if (image) return isHttpUrl(image) || isDataUrl(image) ? { url: image } : { b64_json: image }

  const data = source.data
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!isRecordValue(item)) continue
      const nested = getImageValueFields(item)
      if (nested.b64_json || nested.url) return nested
    }
  } else if (isRecordValue(data)) {
    const nested = getImageValueFields(data)
    if (nested.b64_json || nested.url) return nested
  } else {
    const dataString = getStringValue(source, 'data')
    if (dataString) return isHttpUrl(dataString) || isDataUrl(dataString) ? { url: dataString } : { b64_json: dataString }
  }

  return {}
}

function eventToImageResponseItem(event: Record<string, unknown>): ImageResponseItem {
  return {
    ...getImageValueFields(event),
    revised_prompt: getStringValue(event, 'revised_prompt'),
    size: getStringValue(event, 'size'),
    quality: getStringValue(event, 'quality'),
    output_format: getStringValue(event, 'output_format'),
    output_compression: getNumberValue(event, 'output_compression'),
    moderation: getStringValue(event, 'moderation'),
  }
}

function eventToImageResponseItems(event: Record<string, unknown>): ImageResponseItem[] {
  const direct = eventToImageResponseItem(event)
  if (direct.b64_json || direct.url) return [direct]

  const result = event.result
  if (typeof result === 'string' && result.trim()) {
    return [{ ...eventToImageResponseItem(event), b64_json: result }]
  }
  if (isRecordValue(result)) {
    const item = eventToImageResponseItem({ ...event, ...result })
    return item.b64_json || item.url ? [item] : []
  }

  const data = event.data
  const dataItems = Array.isArray(data)
    ? data
    : isRecordValue(data)
    ? [data]
    : []

  return dataItems
    .filter(isRecordValue)
    .map((item) => eventToImageResponseItem({ ...event, ...item }))
    .filter((item) => Boolean(item.b64_json || item.url))
}

export async function parseImagesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  const completedItems: ImageResponseItem[] = []
  let resultPayload: ImageApiResponse | null = null

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    const object = getStringValue(event, 'object')
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      const b64 = getStringValue(event, 'b64_json') ?? getStringValue(event, 'partial_image_b64')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    if (object === 'image.generation.result' || object === 'image.edit.result') {
      resultPayload = normalizeImageApiPayload(event)
      return
    }

    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      const payload = normalizeImageApiPayload(event)
      if (Array.isArray(payload.data) && payload.data.length) {
        resultPayload = payload
        return
      }
      completedItems.push(...eventToImageResponseItems(event))
    }
  })

  if (resultPayload) {
    return parseImagesApiResponse(resultPayload, mime)
  }

  if (!completedItems.length) {
    throw new Error('流式接口未返回最终图片数据')
  }

  const images = completedItems
    .map((item) => item.b64_json)
    .filter((b64): b64 is string => Boolean(b64))
    .map((b64) => normalizeBase64Image(b64, mime))
  if (!images.length) throw new Error('流式接口未返回可用图片数据')

  const actualParamsList = completedItems.map((item) => mergeActualParams(pickActualParams(item)))
  const actualParams = mergeActualParams(
    actualParamsList[0],
    images.length > 1 ? { n: images.length } : undefined,
  )
  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts: completedItems.map((item) => item.revised_prompt),
  }
}
