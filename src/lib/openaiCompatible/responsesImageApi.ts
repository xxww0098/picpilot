import type { ApiProfile, ResponsesApiResponse, ResponsesOutputItem, TaskParams } from '../../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../devProxy'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  createApiTimeoutError,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  getImageApiFanoutConcurrency,
  loggedFetch,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
} from '../imageApiShared'
import { settleWithConcurrency } from '../runWithConcurrency'
import {
  collectConcurrentFailures,
  createRequestHeaders,
  getNumberValue,
  getStreamPartialImages,
  getStringValue,
  isEventStreamResponse,
  isRecordValue,
  PROMPT_REWRITE_GUARD_PREFIX,
  readJsonServerSentEvents,
} from './shared'

function createResponsesImageTool(
  params: TaskParams,
  isEdit: boolean,
  profile: ApiProfile,
  maskDataUrl?: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (profile.streamImages) {
    tool.partial_images = getStreamPartialImages(profile)
  }

  if (!profile.codexCli) {
    tool.quality = params.quality
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string): Array<{
  image: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}> {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    const err = new Error('接口未返回图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const b64 = getResponsesImageResultBase64(item.result)
    if (b64) {
      results.push({
        image: normalizeBase64Image(b64, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }

  if (!results.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return results
}

function getResponsesImageResultBase64(result: ResponsesOutputItem['result']): string | undefined {
  const b64 = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
    ? typeof result.b64_json === 'string'
      ? result.b64_json
      : typeof result.base64 === 'string'
      ? result.base64
      : typeof result.image === 'string'
      ? result.image
      : typeof result.data === 'string'
      ? result.data
      : ''
    : ''

  return b64.trim() ? b64 : undefined
}


function getResponsesStreamPayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  if (isRecordValue(response)) return response as ResponsesApiResponse

  const item = event.item
  if (isRecordValue(item) && item.type === 'image_generation_call') {
    return { output: [item as ResponsesOutputItem] }
  }

  return null
}

async function parseResponsesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    if (type === 'response.image_generation_call.partial_image') {
      const b64 = getStringValue(event, 'partial_image_b64')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    const payload = getResponsesStreamPayload(event)
    if (!payload) return

    if (type === 'response.output_item.done' && Array.isArray(payload.output)) {
      outputItems.push(...payload.output)
      return
    }

    completedPayload = payload
  })

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error('流式接口未返回最终图片数据')

  let imageResults: ReturnType<typeof parseResponsesImageResults>
  try {
    imageResults = parseResponsesImageResults(payload, mime)
  } catch (err) {
    const collectedImageItems = outputItems.filter((item) => getResponsesImageResultBase64(item.result))
    if (collectedImageItems.length === 0) throw err
    imageResults = parseResponsesImageResults({ output: collectedImageItems }, mime)
  }
  const actualParams = mergeActualParams(imageResults[0]?.actualParams ?? {})
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
    revisedPrompts: imageResults.map((result) => result.revisedPrompt),
  }
}

export async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) {
    return callResponsesImageApiSingle(opts, profile)
  }

  const results = await settleWithConcurrency(
    Array.from({ length: n }),
    getImageApiFanoutConcurrency({ maxConcurrent: opts.fanoutConcurrency }),
    (_, requestIndex) => callResponsesImageApiSingle({
      ...opts,
      onPartialImage: opts.onPartialImage
        ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
        : undefined,
    }, profile),
  )
  
  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    images.length === opts.params.n ? { n: opts.params.n } : { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}), ...collectConcurrentFailures(results) }
}

async function callResponsesImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt, params, inputImageDataUrls } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const requestHeaders = createRequestHeaders(profile, { includeAppAuth: useApiProxy })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createApiTimeoutError(profile.timeout)), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const body: Record<string, unknown> = {
      model: profile.model,
      input: createResponsesInput(prompt, inputImageDataUrls),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl)],
      tool_choice: 'required',
    }
    if (profile.streamImages) {
      body.stream = true
    }

    const responsesUrl = buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy)
    const response = await loggedFetch('Responses /responses', responsesUrl, {
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    }, {
      appMode: opts.telemetry?.appMode ?? 'gallery',
      provider: profile.provider,
      model: profile.model,
      codexCli: profile.codexCli,
      apiProxy: useApiProxy,
      edit: inputImageDataUrls.length > 0,
      inputImages: inputImageDataUrls.length,
      mask: Boolean(opts.maskDataUrl),
      stream: Boolean(profile.streamImages),
      tools: body.tools,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response, 'Responses /responses'))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseResponsesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    const payload = await response.json() as ResponsesApiResponse
    const imageResults = parseResponsesImageResults(payload, mime)
    const actualParams = mergeActualParams(
      imageResults[0]?.actualParams ?? {},
    )
    return {
      images: imageResults.map((result) => result.image),
      actualParams,
      actualParamsList: imageResults.map((result) =>
        mergeActualParams(result.actualParams ?? {}),
      ),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
    }
  } finally {
    clearTimeout(timeoutId)
    opts.signal?.removeEventListener('abort', abortFromCaller)
  }
}
