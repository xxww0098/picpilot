export function getCpaBaseUrlHint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.includes('cliproxy') && !trimmed.includes('cliproxyapi')) {
    return 'Docker 部署时服务名是 cliproxyapi，不是 cliproxy。'
  }
  if (trimmed.includes('localhost') || trimmed.includes('127.0.0.1')) {
    return 'PicPilot 在容器内运行，localhost 指向 PicPilot 自身；请改用 http://cliproxyapi:8317。'
  }
  return null
}

export function getCpaManagementKeyHint(key: string, configured = false): string | null {
  if (configured && !key.trim()) return null
  const trimmed = key.trim()
  if (!trimmed) return null
  if (/^sk-/i.test(trimmed)) {
    return 'sk- 开头的是出图 API Key，不能用于 CPA 管理接口；请填写 config.yaml 的 remote-management.secret-key。'
  }
  return null
}