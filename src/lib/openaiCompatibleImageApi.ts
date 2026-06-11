import type { ApiProfile, CustomProviderDefinition } from '../types'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { callCustomHttpImageApi, getCustomQueuedImageResult } from './openaiCompatible/customProviderImageApi'
import { callImagesApi } from './openaiCompatible/imagesApi'
import { callResponsesImageApi } from './openaiCompatible/responsesImageApi'
import { scheduleImageApiRequest } from './imageRequestScheduler'

export { getCustomQueuedImageResult }

export async function callOpenAICompatibleImageApi(
  opts: CallApiOptions,
  profile: ApiProfile,
  customProvider?: CustomProviderDefinition | null,
): Promise<CallApiResult> {
  if (customProvider) {
    return scheduleImageApiRequest(
      () => callCustomHttpImageApi(opts, profile, customProvider),
      { signal: opts.signal },
    )
  }

  return profile.apiMode === 'responses'
    ? callResponsesImageApi(opts, profile)
    : callImagesApi(opts, profile)
}
