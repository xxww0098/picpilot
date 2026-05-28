import type { ApiProfile } from '../types'
import { readErrorMessage } from './apiClient'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { createRequestHeaders } from './openaiCompatible/shared'

export async function testApiConnection(profile: ApiProfile): Promise<void> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const response = await fetch(buildApiUrl(profile.baseUrl, 'models', proxyConfig, useApiProxy), {
    method: 'GET',
    headers: createRequestHeaders(profile, { includeAppAuth: useApiProxy }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '连通性测试失败'))
  }
}
