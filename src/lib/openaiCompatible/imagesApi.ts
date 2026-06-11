import type { ApiProfile, CustomProviderDefinition } from '../../types'
import {
  type CallApiOptions,
  type CallApiResult,
  getImageApiFanoutConcurrency,
  mergeActualParams,
} from '../imageApiShared'
import { settleWithConcurrency } from '../runWithConcurrency'
import { scheduleImageApiRequest } from '../imageRequestScheduler'
import { collectConcurrentFailures } from './shared'
import { callGptImagesApiSingle } from './gptImageApi'
import { callGrokImagesApiSingle } from './grokImageApi'

export { parseImagesApiResponse, parseImagesApiStreamResponse } from './imagesApiShared'

export async function callImagesApi(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if ((profile.codexCli || (profile.streamImages && n > 1)) && n > 1) {
    return callImagesApiConcurrent(opts, profile, n, customProvider)
  }

  return scheduleImageApiRequest(
    () => callImagesApiSingleDispatch(opts, profile, customProvider),
    { signal: opts.signal },
  )
}

function callImagesApiSingleDispatch(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  if (profile.provider === 'xAI') {
    return callGrokImagesApiSingle(opts, profile, customProvider)
  }
  return callGptImagesApiSingle(opts, profile, customProvider)
}

async function callImagesApiConcurrent(opts: CallApiOptions, profile: ApiProfile, n: number, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const singleOpts = {
    ...opts,
    params: {
      ...opts.params,
      n: 1,
      ...(profile.codexCli ? { quality: 'auto' as const } : {}),
    },
  }
  const results = await settleWithConcurrency(
    Array.from({ length: n }),
    getImageApiFanoutConcurrency({ maxConcurrent: opts.fanoutConcurrency }),
    (_, requestIndex) => scheduleImageApiRequest(
      () => callImagesApiSingleDispatch({
        ...singleOpts,
        onPartialImage: opts.onPartialImage
          ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
          : undefined,
      }, profile, customProvider),
      { signal: opts.signal },
    ),
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
    { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}), ...collectConcurrentFailures(results) }
}
