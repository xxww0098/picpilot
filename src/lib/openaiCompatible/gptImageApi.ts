import type { ApiProfile, CustomProviderDefinition } from '../../types'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from '../imaging/canvasImage'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../config/devProxy'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  createApiTimeoutError,
  getApiErrorMessage,
  loggedFetch,
  MIME_MAP,
} from '../image/imageApiShared'
import {
  createOpenAICompatiblePaths,
  createRequestHeaders,
  getStreamPartialImages,
  isEventStreamResponse,
  PROMPT_REWRITE_GUARD_PREFIX,
} from './shared'
import { parseImagesApiResponse, parseImagesApiStreamResponse } from './imagesApiShared'

export async function callGptImagesApiSingle(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const { prompt: originalPrompt, params, inputImageDataUrls } = opts
  const prompt = profile.codexCli
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${originalPrompt}`
    : originalPrompt
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const requestHeaders = createRequestHeaders(profile, { includeAppAuth: useApiProxy })
  const paths = createOpenAICompatiblePaths(customProvider)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createApiTimeoutError(profile.timeout)), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      formData.append('model', profile.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (!profile.codexCli) {
        formData.append('quality', params.quality)
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }
      if (params.n > 1) {
        formData.append('n', String(params.n))
      }
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }
      if (profile.streamImages) {
        formData.append('stream', 'true')
        formData.append('partial_images', String(getStreamPartialImages(profile)))
      }

      const imageBlobs: Blob[] = []
      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const blob = opts.maskDataUrl && i === 0
          ? await imageDataUrlToPngBlob(dataUrl)
          : await dataUrlToBlob(dataUrl)
        imageBlobs.push(blob)
      }

      const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
      if (opts.maskDataUrl) {
        assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
        assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
      }
      assertImageInputPayloadSize(
        imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0),
      )

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      if (maskBlob) {
        formData.append('mask', maskBlob, 'mask.png')
      }

      response = await loggedFetch('Images /images/edits', buildApiUrl(profile.baseUrl, paths.editPath, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      }, {
        appMode: opts.telemetry?.appMode ?? 'gallery',
        provider: profile.provider,
        model: profile.model,
        codexCli: profile.codexCli,
        apiProxy: useApiProxy,
        inputImages: inputImageDataUrls.length,
        mask: Boolean(opts.maskDataUrl),
        n: params.n,
        stream: Boolean(profile.streamImages),
      })
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        size: params.size,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (!profile.codexCli) {
        body.quality = params.quality
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }
      if (profile.responseFormatB64Json) {
        body.response_format = 'b64_json'
      }
      if (profile.streamImages) {
        body.stream = true
        body.partial_images = getStreamPartialImages(profile)
      }

      response = await loggedFetch('Images /images/generations', buildApiUrl(profile.baseUrl, paths.generationPath, proxyConfig, useApiProxy), {
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
        size: params.size,
        output_format: params.output_format,
        n: params.n,
        stream: Boolean(profile.streamImages),
      })
    }

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response, isEdit ? 'Images /images/edits' : 'Images /images/generations'))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseImagesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    return parseImagesApiResponse(await response.json(), mime, controller.signal)
  } finally {
    clearTimeout(timeoutId)
    opts.signal?.removeEventListener('abort', abortFromCaller)
  }
}
