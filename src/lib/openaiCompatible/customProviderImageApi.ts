import type { ApiProfile, CustomProviderDefinition, CustomProviderPollMapping, CustomProviderResultMapping, CustomProviderSubmitMapping, TaskParams } from '../../types'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from '../canvasImage'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../devProxy'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  createApiTimeoutError,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  loggedFetch,
  MIME_MAP,
  normalizeBase64Image,
} from '../imageApiShared'
import {
  appendQuery,
  createRequestHeaders,
  getAllByPath,
  getByPath,
  sleep,
} from './shared'

function getTaskState(payload: unknown, poll: CustomProviderPollMapping): 'success' | 'failure' | 'pending' {
  const status = getByPath(payload, poll.statusPath)
  const statusText = typeof status === 'string' ? status : String(status ?? '')
  if (poll.successValues.includes(statusText)) return 'success'
  if (poll.failureValues.includes(statusText)) return 'failure'
  return 'pending'
}

function isRecoverablePollingError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isRetryablePollingStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function buildTaskPath(path: string, taskId: string): string {
  return path
    .replace(/\{task_id\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
}

function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return getByPath(context, value.slice(1))
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}

function createCustomProviderContext(opts: CallApiOptions, profile: ApiProfile) {
  return {
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImages: {
      dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined,
      count: opts.inputImageDataUrls.length,
    },
    mask: {
      dataUrl: opts.maskDataUrl,
    },
  }
}

function renderQuery(query: Record<string, string> | undefined, context: Record<string, unknown>): Record<string, string> | undefined {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

async function createCustomMultipartBody(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, context: Record<string, unknown>): Promise<FormData> {
  const formData = new FormData()
  const body = resolveTemplateValue(mapping.body ?? {}, context)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) formData.append(key, String(item))
      } else {
        formData.append(key, String(value))
      }
    }
  }

  const needsInputImages = mapping.files?.some((file) => file.source === 'inputImages')
  const needsMask = mapping.files?.some((file) => file.source === 'mask')
  const imageBlobs: Blob[] = []
  if (needsInputImages) {
    for (let i = 0; i < opts.inputImageDataUrls.length; i++) {
      const dataUrl = opts.inputImageDataUrls[i]
      const blob = opts.maskDataUrl && i === 0 ? await imageDataUrlToPngBlob(dataUrl) : await dataUrlToBlob(dataUrl)
      imageBlobs.push(blob)
    }
  }
  const maskBlob = needsMask && opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
  if (opts.maskDataUrl && (needsInputImages || needsMask)) {
    assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
    assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
  }
  assertImageInputPayloadSize(imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0))

  for (const file of mapping.files ?? []) {
    if (file.source === 'inputImages') {
      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append(file.field, blob, `input-${i + 1}.${ext}`)
      }
    } else if (file.source === 'mask' && maskBlob) {
      formData.append(file.field, maskBlob, 'mask.png')
    }
  }

  return formData
}

async function extractCustomImages(payload: unknown, result: CustomProviderResultMapping, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const images: string[] = []
  const imageUrls = (result.imageUrlPaths ?? []).flatMap((path) =>
    getAllByPath(payload, path).filter((value): value is string => isHttpUrl(value) || isDataUrl(value)),
  )
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  try {
    for (const path of result.b64JsonPaths ?? []) {
      for (const value of getAllByPath(payload, path)) {
        if (typeof value === 'string' && value.trim()) images.push(normalizeBase64Image(value, mime))
      }
    }
    for (const url of imageUrls) {
      images.push(await fetchImageUrlAsDataUrl(url, mime, signal))
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认接口实际返回的数据结构，并根据 API 文档调整「自定义服务商」配置中的结果提取路径。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function submitCustomRequest(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, profile: ApiProfile, controller: AbortController, proxyConfig: ReturnType<typeof readClientDevProxyConfig>, useApiProxy: boolean): Promise<unknown> {
  const requestHeaders = createRequestHeaders(profile, { includeAppAuth: useApiProxy })
  const context = createCustomProviderContext(opts, profile)
  const method = mapping.method ?? 'POST'
  const contentType = mapping.contentType ?? 'json'
  const path = appendQuery(mapping.path, renderQuery(mapping.query, context))
  const headers: Record<string, string> = { ...requestHeaders }
  let body: BodyInit | undefined

  if (method !== 'GET') {
    if (contentType === 'multipart') {
      const formData = await createCustomMultipartBody(mapping, opts, context)
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }
      body = formData
    } else {
      assertImageInputPayloadSize(
        opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
          (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
      )
      headers['Content-Type'] = 'application/json'
      const resolved = resolveTemplateValue(mapping.body ?? {}, context)
      if (profile.responseFormatB64Json && resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
        (resolved as Record<string, unknown>).response_format = 'b64_json'
      }
      body = JSON.stringify(resolved)
    }
  }

  const response = await loggedFetch('自定义服务商提交', buildApiUrl(profile.baseUrl, path, proxyConfig, useApiProxy), {
    method,
    headers,
    cache: 'no-store',
    body,
    signal: controller.signal,
  }, {
    provider: profile.provider,
    contentType,
    apiProxy: useApiProxy,
  })

  if (!response.ok) throw new Error(await getApiErrorMessage(response, '自定义服务商提交'))
  return response.json()
}

async function pollCustomTaskResult(
  profile: ApiProfile,
  poll: CustomProviderPollMapping,
  taskId: string,
  mime: string,
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = createRequestHeaders(profile)
  let isFirstPoll = true

  while (true) {
    if (isFirstPoll) {
      isFirstPoll = false
    } else if (signal) {
      await sleep((poll.intervalSeconds ?? 5) * 1000, signal)
    } else {
      await new Promise((resolve) => setTimeout(resolve, (poll.intervalSeconds ?? 5) * 1000))
    }

    const taskPath = appendQuery(buildTaskPath(poll.path, taskId), poll.query)
    let taskPayload: unknown
    try {
      const taskResponse = await loggedFetch('自定义服务商轮询', buildApiUrl(profile.baseUrl, taskPath, proxyConfig, false), {
        method: poll.method ?? 'GET',
        headers: requestHeaders,
        cache: 'no-store',
        signal,
      }, { provider: profile.provider, taskId })

      if (!taskResponse.ok) {
        if (isRetryablePollingStatus(taskResponse.status)) continue
        throw new Error(await getApiErrorMessage(taskResponse, '自定义服务商轮询'))
      }

      taskPayload = await taskResponse.json()
    } catch (err) {
      if (!signal?.aborted && isRecoverablePollingError(err)) continue
      throw err
    }

    const state = getTaskState(taskPayload, poll)
    if (state === 'failure') {
      const message = getByPath(taskPayload, poll.errorPath) || getByPath(taskPayload, 'message') || getByPath(taskPayload, 'data.fail_reason') || getByPath(taskPayload, 'error.message')
      throw new Error(typeof message === 'string' && message.trim() ? message : '异步任务失败')
    }
    if (state === 'success') {
      try {
        return await extractCustomImages(taskPayload, poll.result, mime, signal)
      } catch (err) {
        if (!signal?.aborted && isRecoverablePollingError(err)) continue
        throw err
      }
    }
  }
}

export async function getCustomQueuedImageResult(
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  taskId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  if (!customProvider.poll) throw new Error('自定义异步任务缺少 poll 配置')
  const mime = MIME_MAP[params.output_format] || 'image/png'
  return pollCustomTaskResult(profile, customProvider.poll, taskId, mime)
}

export async function callCustomHttpImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider: CustomProviderDefinition): Promise<CallApiResult> {
  const { params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(createApiTimeoutError(profile.timeout)), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const proxyConfig = readClientDevProxyConfig()
    const useApiProxy = shouldUseApiProxy()
    const submitMapping = isEdit && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
    if (useApiProxy && (submitMapping.method ?? 'POST') !== 'POST') {
      throw new Error('团队 API 代理暂不支持使用 GET 提交的自定义服务商。请改用 POST 提交的自定义服务商配置。')
    }
    if (useApiProxy && (submitMapping.taskIdPath || customProvider.poll)) {
      throw new Error('团队 API 代理暂不支持使用异步任务的自定义服务商。请改用同步返回图片的自定义服务商配置。')
    }
    const submitPayload = await submitCustomRequest(submitMapping, opts, profile, controller, proxyConfig, useApiProxy)
    const taskIdValue = submitMapping.taskIdPath ? getByPath(submitPayload, submitMapping.taskIdPath) : undefined
    const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
    if (submitMapping.taskIdPath && !taskId) {
      const err = new Error('无法从响应中提取异步任务 ID，请查看原始响应内容确认接口实际返回的数据结构，并根据 API 文档调整「自定义服务商」配置中的 taskIdPath。')
      ;(err as any).rawResponsePayload = JSON.stringify(submitPayload, null, 2)
      throw err
    }
    if (!taskId) return extractCustomImages(submitPayload, submitMapping.result ?? {}, mime, controller.signal)
    if (!customProvider.poll) throw new Error('异步接口返回了 task_id，但服务商配置缺少 poll')
    opts.onCustomTaskEnqueued?.({ taskId })
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    return pollCustomTaskResult(profile, customProvider.poll, taskId, mime, controller.signal)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    opts.signal?.removeEventListener('abort', abortFromCaller)
  }
}
