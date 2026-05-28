import type { ApiProfile, CustomProviderDefinition } from '../types'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { callCustomHttpImageApi, getCustomQueuedImageResult } from './openaiCompatible/customProviderImageApi'
import { callImagesApi } from './openaiCompatible/imagesApi'
import { callResponsesImageApi } from './openaiCompatible/responsesImageApi'

export { getCustomQueuedImageResult }

export async function callOpenAICompatibleImageApi(
  opts: CallApiOptions,
  profile: ApiProfile,
  customProvider?: CustomProviderDefinition | null,
): Promise<CallApiResult> {
  if (customProvider) {
    return callCustomHttpImageApi(opts, profile, customProvider)
  }

  return profile.apiMode === 'responses'
    ? callResponsesImageApi(opts, profile)
    : callImagesApi(opts, profile)
}
