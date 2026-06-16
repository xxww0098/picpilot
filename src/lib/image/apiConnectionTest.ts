import type { ApiProfile } from '../../types'
import { readErrorMessage } from '../shared/apiClient'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../config/devProxy'
import { logger, serializeError } from '../shared/logger'
import { createRequestHeaders } from '../openaiCompatible/shared'

export async function testApiConnection(profile: ApiProfile): Promise<void> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy()
  const url = buildApiUrl(profile.baseUrl, 'models', proxyConfig, useApiProxy)
  logger.info('api', '连通性测试开始', { url, provider: profile.provider })
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: createRequestHeaders(profile, { includeAppAuth: useApiProxy }),
    })

    if (!response.ok) {
      const msg = await readErrorMessage(response, '连通性测试失败')
      logger.warn('api', `连通性测试失败 (HTTP ${response.status})`, { url, elapsedMs: Date.now() - startedAt, status: response.status })
      throw new Error(msg)
    }
    logger.info('api', '连通性测试成功', { url, elapsedMs: Date.now() - startedAt })
  } catch (err) {
    if (err instanceof Error && err.message !== '连通性测试失败') {
      logger.error('api', '连通性测试网络错误', { url, elapsedMs: Date.now() - startedAt, error: serializeError(err) })
    }
    throw err
  }
}
