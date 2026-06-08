import type { ApiProfile, CustomProviderDefinition } from '../../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../devProxy'
import {
  type CallApiOptions,
  type CallApiResult,
  createApiTimeoutError,
  getApiErrorMessage,
  loggedFetch,
} from '../imageApiShared'
import {
  createOpenAICompatiblePaths,
  createRequestHeaders,
  getStreamPartialImages,
  isEventStreamResponse,
  PROMPT_REWRITE_GUARD_PREFIX,
} from './shared'
import { parseImagesApiResponse, parseImagesApiStreamResponse } from './imagesApiShared'

const GROK_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20'] as const

function sizeToAspectRatio(size: string): string {
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return 'auto'
  const w = Number(match[1])
  const h = Number(match[2])
  if (!w || !h) return 'auto'
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const d = gcd(w, h)
  const rw = w / d
  const rh = h / d
  const candidate = `${rw}:${rh}`
  if ((GROK_ASPECT_RATIOS as readonly string[]).includes(candidate)) return candidate
  return 'auto'
}

function sizeToResolution(size: string): string | undefined {
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return undefined
  const maxEdge = Math.max(Number(match[1]), Number(match[2]))
  if (maxEdge <= 1024) return '1k'
  return '2k'
}

function appendGrokImageSizing(body: Record<string, unknown>, size: string) {
  const aspectRatio = sizeToAspectRatio(size)
  if (aspectRatio !== 'auto') body.aspect_ratio = aspectRatio
  const resolution = sizeToResolution(size)
  if (resolution) body.resolution = resolution
}

export async function callGrokImagesApiSingle(opts: CallApiOptions, profile: ApiProfile, _customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const { prompt: originalPrompt, params, inputImageDataUrls } = opts
  const prompt = profile.codexCli
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${originalPrompt}`
    : originalPrompt
  const isEdit = inputImageDataUrls.length > 0
  const mime = 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const requestHeaders = createRequestHeaders(profile, { includeAppAuth: useApiProxy })
  const paths = createOpenAICompatiblePaths()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createApiTimeoutError(profile.timeout)), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    let response: Response

    if (isEdit) {
      if (opts.maskDataUrl) {
        throw new Error('Grok 图像编辑暂不支持遮罩局部重绘，请移除遮罩后使用参考图编辑。')
      }
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        image: inputImageDataUrls.length === 1 ? inputImageDataUrls[0] : inputImageDataUrls,
        response_format: 'b64_json',
      }
      appendGrokImageSizing(body, params.size)
      if (params.n > 1) body.n = params.n
      if (profile.streamImages) {
        body.stream = true
        body.partial_images = getStreamPartialImages(profile)
      }

      response = await loggedFetch('Images /images/edits', buildApiUrl(profile.baseUrl, paths.editPath, proxyConfig, useApiProxy), {
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
        inputImages: inputImageDataUrls.length,
        mask: Boolean(opts.maskDataUrl),
        n: params.n,
        stream: Boolean(profile.streamImages),
      })
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        response_format: 'b64_json',
      }
      appendGrokImageSizing(body, params.size)
      if (params.n > 1) body.n = params.n
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
