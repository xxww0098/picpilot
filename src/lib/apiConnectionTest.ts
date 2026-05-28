import type { ApiProfile } from '../types'
import { DEFAULT_FAL_BASE_URL } from './apiProfiles'
import { readErrorMessage } from './apiClient'
import { getStoredAuthToken } from './auth'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { createRequestHeaders } from './openaiCompatible/shared'

export async function testApiConnection(profile: ApiProfile): Promise<void> {
  if (profile.provider === 'fal') {
    await testFalConnection(profile)
    return
  }

  await testOpenAICompatibleConnection(profile)
}

async function testOpenAICompatibleConnection(profile: ApiProfile): Promise<void> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const response = await fetch(buildApiUrl(profile.baseUrl, 'models', proxyConfig, useApiProxy), {
    method: 'GET',
    headers: createRequestHeaders(profile, { includeAppAuth: useApiProxy }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '连通性测试失败'))
  }
}

async function testFalConnection(profile: ApiProfile): Promise<void> {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      ...(profile.apiKey.trim() ? { Authorization: `Key ${profile.apiKey.trim()}` } : {}),
      ...(getStoredAuthToken() ? { 'X-PicPilot-Authorization': `Bearer ${getStoredAuthToken()}` } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'fal.ai 连通性测试失败'))
  }
}
