const EVENT_TYPE_LABELS: Record<string, string> = {
  success: '成功',
  failure: '失败',
  timeout: '超时',
  cancelled: '已取消',
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  timeout: '请求超时',
  cancelled: '已取消',
  rate_limit: '额度或限流',
  auth: '认证失败',
  forbidden: '权限不足',
  invalid_request: '请求参数无效',
  server_error: '服务端错误',
  network: '网络或跨域问题',
  unknown: '未知错误',
}

const HTTP_STATUS_LABELS: Record<number, string> = {
  400: '400 请求参数无效',
  401: '401 未认证',
  403: '403 无权限',
  404: '404 不存在',
  408: '408 请求超时',
  413: '413 内容过大',
  429: '429 额度或频率限制',
  500: '500 服务端错误',
  502: '502 上游请求失败',
  503: '503 服务不可用',
  504: '504 网关超时',
}

const PARAM_VALUE_LABELS: Record<string, Record<string, string>> = {
  size: {
    auto: '自动',
  },
  quality: {
    auto: '自动',
    low: '低',
    medium: '中',
    high: '高',
  },
  output_format: {
    png: 'PNG',
    jpeg: 'JPEG',
    webp: 'WebP',
  },
  moderation: {
    auto: '自动',
    low: '低强度',
  },
  n: {
    auto: '自动',
  },
}

function cleanTechnicalPrefix(message: string): string {
  return message
    .trim()
    .replace(/^(?:error|typeerror|domexception|aborterror):\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function preserveHint(message: string, firstLine: string): string {
  const rest = message.split(/\r?\n/).slice(1).join('\n').trim()
  return rest ? `${firstLine}\n${rest}` : firstLine
}

export function getEventTypeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  return EVENT_TYPE_LABELS[value] ?? value
}

export function getErrorTypeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  return ERROR_TYPE_LABELS[value] ?? value
}

export function getApiModeLabel(value: string | null | undefined): string {
  if (value === 'images') return 'Images API（图像接口）'
  if (value === 'responses') return 'Responses API（对话接口）'
  return value || '—'
}

export function getProviderDisplayName(value: string | null | undefined): string {
  if (!value) return '—'
  if (value === 'openai') return 'OpenAI 兼容'
  return value
}

export function getHttpStatusLabel(status: number | null | undefined): string {
  if (status == null) return '—'
  return HTTP_STATUS_LABELS[status] ?? String(status)
}

export function getParamValueLabel(paramKey: string, value: string | number | null | undefined): string {
  if (value == null || value === '') return '—'
  const raw = String(value)
  return PARAM_VALUE_LABELS[paramKey]?.[raw] ?? raw
}

export function getUserFacingErrorMessage(error: unknown, fallback = '操作失败', httpStatus?: number): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = cleanTechnicalPrefix(raw || fallback)
  if (!message) return fallback

  // 后端已给出清晰文案的场景直接透传（含排队繁忙提示，避免被下方通用 429 文案覆盖为"额度已用完"）。
  if (/用户名或密码错误|登录失败次数过多|邀请码|密码至少|用户名长度|用户名已被占用|额度|团队服务|批量生成数量上限|服务繁忙|排队/.test(message)) {
    return message
  }

  if (/API 代理未配置上游地址|上游 API 地址未配置/.test(message)) {
    return '团队 API 代理还没有配置上游地址，请管理员检查部署环境中的 API_PROXY_URL。'
  }

  if (/API_PROXY_URL 只支持 http\/https/.test(message)) {
    return '团队 API 代理地址格式无效，只支持 http:// 或 https:// 开头的地址。'
  }

  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(message)) {
    return preserveHint(
      message,
      '网络请求失败：无法连接到团队 API 代理，请稍后重试或联系管理员。',
    )
  }

  if (/unexpected token|not valid json|invalid json|JSON/i.test(message) && /parse|解析|unexpected|invalid/i.test(message)) {
    return '响应解析失败：上游返回的不是有效 JSON，请联系管理员检查 API_PROXY_URL 是否指向正确的接口。'
  }

  if (/timeout|超时/i.test(message)) {
    return preserveHint(message, message.includes('超时') ? message.split(/\r?\n/)[0] : '请求超时：上游长时间没有返回，请稍后重试或调大超时时间。')
  }

  if (/unauthorized|invalid authentication|invalid[\s_-]*api[\s_-]*key|missing[\s_-]*api[\s_-]*key|401/i.test(message)) {
    return '认证失败：上游 API Key 无效或已过期，请联系管理员检查 API_PROXY_API_KEY。'
  }

  if (/forbidden|403/i.test(message)) {
    return '权限不足：当前账号或团队 API Key 没有执行此操作的权限。'
  }

  if (/rate.?limit|too many requests|429/i.test(message)) {
    return '请求被限制：可能是上游额度已用完或请求过于频繁，请稍后再试；如反复出现请联系管理员。'
  }

  if (/HTTP\s*(500|502|503|504)|\b(500|502|503|504)\b/.test(message) || (httpStatus != null && httpStatus >= 500)) {
    const statusText = httpStatus ? `HTTP ${httpStatus}` : '5xx'
    return `服务暂时不可用：上游或代理返回 ${statusText}，请稍后重试。`
  }

  if (httpStatus === 401) return '登录状态已失效，请重新登录。'
  if (httpStatus === 403) return '权限不足：当前账号不能执行此操作。'
  if (httpStatus === 404) return '请求的内容不存在，可能已被删除。'
  if (httpStatus === 413) return '上传内容过大，请压缩图片或减少上传内容后重试。'
  if (httpStatus === 429) return '请求过于频繁或额度已用完，请稍后再试；如反复出现请联系管理员。'

  return message
}
