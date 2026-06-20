import { useEffect, useState } from 'react'
import { fetchAdminTeamSettings, patchAdminTeamSettings, type AdminOutboundProxyType } from '../../lib/server/adminApi'
import { OUTPUT_FORMAT_OPTIONS, formatOutputFormatList, normalizeAllowedOutputFormats } from '../../lib/params/outputFormats'
import { openPromptDialog, showAppToast } from '../../lib/ui/dialog'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import { useAuth } from '../../contexts/AuthProvider'
import Button from '../ui/Button'
import Input from '../ui/Input'
import { Card } from '../ui/Card'
import QueryState from './QueryState'
import type { OutputImageFormat } from '../../types'

export default function TeamSettings() {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchAdminTeamSettings(), [])
  const { patchUser } = useAuth()
  const [saving, setSaving] = useState(false)

  function syncCurrentUser(updated: Awaited<ReturnType<typeof patchAdminTeamSettings>>) {
    patchUser({
      maxBatchImages: updated.defaultMaxBatchImages,
      galleryAutoRetryCount: updated.galleryAutoRetryCount,
      maxConcurrent: updated.maxConcurrent,
      maxQueue: updated.maxQueue,
      proxyUserSoftLimit: updated.proxyUserSoftLimit,
      streamFallbackEnabled: updated.streamFallbackEnabled,
      requestTimeoutSeconds: updated.requestTimeoutSeconds,
      allowedOutputFormats: normalizeAllowedOutputFormats(updated.allowedOutputFormats),
    })
  }

  // 通用编辑器：弹数字输入框 → 校验 → PATCH → 重载 → toast。
  function editNumber(opts: {
    title: string
    message: string
    current: number
    min: number
    max: number
    toField: (val: number) => Parameters<typeof patchAdminTeamSettings>[0]
    successMessage: string
  }) {
    openPromptDialog({
      title: opts.title,
      message: opts.message,
      defaultValue: String(opts.current),
      inputType: 'number',
      validate: (raw) => {
        const val = Number(raw)
        if (!Number.isFinite(val) || val < opts.min || val > opts.max) return `请输入 ${opts.min} 到 ${opts.max} 之间的数字。`
        return null
      },
      onConfirm: async (raw) => {
        setSaving(true)
        try {
          const updated = await patchAdminTeamSettings(opts.toField(Math.trunc(Number(raw))))
          syncCurrentUser(updated)
          await reload()
          showAppToast(opts.successMessage, 'success')
        } catch (e) {
          showAppToast(getUserFacingErrorMessage(e, '保存失败'), 'error')
        } finally {
          setSaving(false)
        }
      },
    })
  }

  async function toggleStreamFallback(current: boolean) {
    setSaving(true)
    try {
      const updated = await patchAdminTeamSettings({ streamFallbackEnabled: !current })
      syncCurrentUser(updated)
      await reload()
      showAppToast(updated.streamFallbackEnabled ? '流式失败回退已开启。' : '流式失败回退已关闭。', 'success')
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function updateOutboundProxy(proxyType: AdminOutboundProxyType, proxyUrl: string) {
    setSaving(true)
    try {
      await patchAdminTeamSettings({
        outboundProxyType: proxyType,
        outboundProxyUrl: proxyTypeNeedsUrl(proxyType) ? proxyUrl.trim() : '',
      })
      await reload()
      showAppToast('全局出站代理已更新。', 'success')
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function updateCLIProxySettings(apiUrl: string, managementKey: string) {
    setSaving(true)
    try {
      const body: Parameters<typeof patchAdminTeamSettings>[0] = { cliproxyApiUrl: apiUrl.trim() }
      if (managementKey.trim()) body.cliproxyManagementKey = managementKey.trim()
      await patchAdminTeamSettings(body)
      await reload()
      showAppToast('CPA 服务器配置已更新。', 'success')
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function updateAllowedOutputFormats(nextFormats: OutputImageFormat[]) {
    setSaving(true)
    try {
      const updated = await patchAdminTeamSettings({ allowedOutputFormats: nextFormats })
      syncCurrentUser(updated)
      await reload()
      showAppToast('可选出图格式已更新。', 'success')
    } catch (e) {
      showAppToast(getUserFacingErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <QueryState loading={loading} error={error}>
      {data && (
        <article className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
          <div>
            <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">团队服务配置</h3>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">并发控制、批量限制、失败恢复与请求超时，修改即时生效。</p>
          </div>

          <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SettingCard
              label="团队并发"
              value={data.maxConcurrent}
              unit="个请求"
              disabled={saving}
              onEdit={() => editNumber({
                title: '团队并发',
                message: '全局同时在途的出图请求数，超出的进入排队。范围 1-100。调高会增大对上游出图代理的压力。',
                current: data.maxConcurrent,
                min: 1,
                max: 100,
                toField: (val) => ({ maxConcurrent: val }),
                successMessage: '团队并发已更新。',
              })}
            />
            <SettingCard
              label="排队上限"
              value={data.maxQueue}
              unit="个等待"
              disabled={saving}
              onEdit={() => editNumber({
                title: '排队上限',
                message: '并发占满后最多允许多少请求排队等待，超出立即返回 429。范围 0-1000（0 表示不排队）。',
                current: data.maxQueue,
                min: 0,
                max: 1000,
                toField: (val) => ({ maxQueue: val }),
                successMessage: '排队上限已更新。',
              })}
            />
            <SettingCard
              label="单用户软上限"
              value={data.proxyUserSoftLimit}
              unit={data.proxyUserSoftLimit === 0 ? '关闭' : '个请求'}
              disabled={saving}
              onEdit={() => editNumber({
                title: '单用户软上限',
                message: '0 表示关闭。启用后，某个用户已占用该数量的在途请求且后方有其他用户等待时，会优先放行其他用户。范围 0-100。',
                current: data.proxyUserSoftLimit,
                min: 0,
                max: 100,
                toField: (val) => ({ proxyUserSoftLimit: val }),
                successMessage: '单用户软上限已更新。',
              })}
            />
            <SettingCard
              label="单用户硬上限"
              value={data.proxyUserHardLimit}
              unit={data.proxyUserHardLimit === 0 ? '关闭' : '个请求'}
              disabled={saving}
              onEdit={() => editNumber({
                title: '单用户硬上限',
                message: '0 表示关闭。启用后，某个用户在途+排队的请求总数达到该值时，其新的同步出图请求直接返回 429（异步任务不受限，仍会排队）。用于防止单用户 fan-out 占满队列。范围 0-100。',
                current: data.proxyUserHardLimit,
                min: 0,
                max: 100,
                toField: (val) => ({ proxyUserHardLimit: val }),
                successMessage: '单用户硬上限已更新。',
              })}
            />
            <SettingCard
              label="逆向单账号并发"
              value={data.reverseAccountConcurrency}
              unit="个请求/账号"
              disabled={saving}
              onEdit={() => editNumber({
                title: '逆向单账号并发',
                message: '内置 ChatGPT reverse 每个账号同时执行的请求数。单 IP 账号池建议保持 1；调高可能触发上游限流或 Cloudflare 拦截。范围 1-5。',
                current: data.reverseAccountConcurrency,
                min: 1,
                max: 5,
                toField: (val) => ({ reverseAccountConcurrency: val }),
                successMessage: '逆向单账号并发已更新。',
              })}
            />
            <SettingCard
              label="默认批量上限"
              value={data.defaultMaxBatchImages}
              unit="张 / 次"
              disabled={saving}
              onEdit={() => editNumber({
                title: '默认批量上限',
                message: '团队统一的单次批量出图上限。范围 1-100。',
                current: data.defaultMaxBatchImages,
                min: 1,
                max: 100,
                toField: (val) => ({ defaultMaxBatchImages: val }),
                successMessage: '默认批量上限已更新。',
              })}
            />
            <SettingCard
              label="失败自动重试"
              value={data.galleryAutoRetryCount}
              unit="次"
              disabled={saving}
              onEdit={() => editNumber({
                title: '失败自动重试',
                message: '画廊批量卡片中有图片失败时，自动补重试失败槽位的次数。范围 0-5，0 表示关闭。',
                current: data.galleryAutoRetryCount,
                min: 0,
                max: 5,
                toField: (val) => ({ galleryAutoRetryCount: val }),
                successMessage: '失败自动重试次数已更新。',
              })}
            />
            <OutputFormatSettingCard
              allowedOutputFormats={data.allowedOutputFormats}
              disabled={saving}
              onSave={(formats) => void updateAllowedOutputFormats(formats)}
            />
            <SettingCard
              label="统一请求超时"
              value={data.requestTimeoutSeconds}
              unit="秒"
              disabled={saving}
              onEdit={() => editNumber({
                title: '统一请求超时',
                message: '图片、Agent、视频请求使用的团队超时基准。范围 30-3600 秒。',
                current: data.requestTimeoutSeconds,
                min: 30,
                max: 3600,
                toField: (val) => ({ requestTimeoutSeconds: val }),
                successMessage: '统一请求超时已更新。',
              })}
            />
            <BooleanSettingCard
              label="流式失败回退"
              enabled={data.streamFallbackEnabled}
              disabled={saving}
              onToggle={() => void toggleStreamFallback(data.streamFallbackEnabled)}
            />
            <ProxySettingCard
              proxyType={data.outboundProxyType}
              proxyUrl={data.outboundProxyUrl}
              disabled={saving}
              onSave={(proxyType, proxyUrl) => void updateOutboundProxy(proxyType, proxyUrl)}
            />
            <CLIProxySettingCard
              apiUrl={data.cliproxyApiUrl}
              keyConfigured={data.cliproxyManagementKeyConfigured}
              disabled={saving}
              onSave={(apiUrl, managementKey) => void updateCLIProxySettings(apiUrl, managementKey)}
            />
          </dl>
        </article>
      )}
    </QueryState>
  )
}

function CLIProxySettingCard({ apiUrl, keyConfigured, disabled, onSave }: {
  apiUrl: string
  keyConfigured: boolean
  disabled: boolean
  onSave: (apiUrl: string, managementKey: string) => void
}) {
  const [nextUrl, setNextUrl] = useState(apiUrl)
  const [nextKey, setNextKey] = useState('')

  useEffect(() => {
    setNextUrl(apiUrl)
    setNextKey('')
  }, [apiUrl, keyConfigured])

  const normalizedUrl = nextUrl.trim()
  const normalizedKey = nextKey.trim()
  const dirty = normalizedUrl !== apiUrl.trim() || normalizedKey.length > 0
  const canSave = dirty && (normalizedUrl === '' || /^https?:\/\//i.test(normalizedUrl))

  return (
    <Card className="sm:col-span-2 xl:col-span-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <label className="min-w-0 flex-1 text-xs font-medium text-[hsl(var(--muted-foreground))]">
          <span className="mb-1 block">CPA 服务器地址</span>
          <Input
            value={nextUrl}
            disabled={disabled}
            onChange={(event) => setNextUrl(event.target.value)}
            placeholder="https://cpa.example.com"
            className="w-full"
          />
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-[hsl(var(--muted-foreground))]">
          <span className="mb-1 block">管理密钥</span>
          <Input
            value={nextKey}
            disabled={disabled}
            type="password"
            onChange={(event) => setNextKey(event.target.value)}
            placeholder={keyConfigured ? '已配置，留空保留' : '未配置'}
            className="w-full"
          />
        </label>
        <Button variant="primary" disabled={disabled || !canSave} onClick={() => onSave(normalizedUrl, normalizedKey)}>
          保存 CPA
        </Button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
        用于在逆向账号页读取远程 CPA / CLIProxyAPI 的 OpenAI OAuth 账号列表并批量导入。
      </p>
    </Card>
  )
}

const OUTBOUND_PROXY_OPTIONS: Array<{ value: AdminOutboundProxyType; label: string }> = [
  { value: 'env', label: '环境变量' },
  { value: 'none', label: '不使用代理' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks5h', label: 'SOCKS5H' },
]

function proxyTypeNeedsUrl(proxyType: AdminOutboundProxyType) {
  return proxyType === 'http' || proxyType === 'https' || proxyType === 'socks5' || proxyType === 'socks5h'
}

function ProxySettingCard({ proxyType, proxyUrl, disabled, onSave }: {
  proxyType: AdminOutboundProxyType
  proxyUrl: string
  disabled: boolean
  onSave: (proxyType: AdminOutboundProxyType, proxyUrl: string) => void
}) {
  const [nextType, setNextType] = useState<AdminOutboundProxyType>(proxyType)
  const [nextUrl, setNextUrl] = useState(proxyUrl)

  useEffect(() => {
    setNextType(proxyType)
    setNextUrl(proxyUrl)
  }, [proxyType, proxyUrl])

  const needsUrl = proxyTypeNeedsUrl(nextType)
  const normalizedUrl = needsUrl ? nextUrl.trim() : ''
  const dirty = nextType !== proxyType || normalizedUrl !== (proxyTypeNeedsUrl(proxyType) ? proxyUrl.trim() : '')
  const canSave = dirty && (!needsUrl || normalizedUrl.length > 0)

  return (
    <Card className="sm:col-span-2 xl:col-span-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <label className="min-w-40 text-xs font-medium text-[hsl(var(--muted-foreground))]">
          <span className="mb-1 block">出站代理类型</span>
          <select
            value={nextType}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value as AdminOutboundProxyType
              setNextType(value)
              if (!proxyTypeNeedsUrl(value)) setNextUrl('')
            }}
            className="h-9 w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.35)] px-3 text-sm text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--ring)/0.35)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {OUTBOUND_PROXY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-[hsl(var(--muted-foreground))]">
          <span className="mb-1 block">代理地址</span>
          <Input
            value={nextUrl}
            disabled={disabled || !needsUrl}
            onChange={(event) => setNextUrl(event.target.value)}
            placeholder={needsUrl ? 'host:port 或 scheme://host:port' : '当前模式不需要地址'}
            className="w-full"
          />
        </label>
        <Button variant="primary" disabled={disabled || !canSave} onClick={() => onSave(nextType, normalizedUrl)}>
          保存代理
        </Button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
        作用于服务端访问 ChatGPT、上游 API 与图片下载；环境变量模式继续读取容器的代理环境变量。
      </p>
    </Card>
  )
}

function BooleanSettingCard({ label, enabled, disabled, onToggle }: {
  label: string
  enabled: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</dt>
        <Button variant="link" size="xs" disabled={disabled} onClick={onToggle}>
          切换
        </Button>
      </div>
      <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
        <span className="text-2xl font-semibold">{enabled ? '开启' : '关闭'}</span>
      </dd>
    </Card>
  )
}

function OutputFormatSettingCard({ allowedOutputFormats, disabled, onSave }: {
  allowedOutputFormats: OutputImageFormat[]
  disabled: boolean
  onSave: (formats: OutputImageFormat[]) => void
}) {
  const normalized = normalizeAllowedOutputFormats(allowedOutputFormats)
  const [draft, setDraft] = useState<OutputImageFormat[]>(normalized)

  useEffect(() => {
    setDraft(normalizeAllowedOutputFormats(allowedOutputFormats))
  }, [allowedOutputFormats])

  const dirty = draft.join(',') !== normalized.join(',')
  const canSave = dirty && draft.length > 0

  return (
    <Card className="sm:col-span-2 xl:col-span-4">
      <div className="flex items-center justify-between">
        <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">可选出图格式</dt>
        <Button variant="link" size="xs" disabled={disabled || !canSave} onClick={() => onSave(draft)}>
          保存
        </Button>
      </div>
      <dd className="mt-1 flex items-center justify-between gap-3">
        <span className="text-2xl font-semibold tabular-nums text-[hsl(var(--foreground))]">
          {formatOutputFormatList(normalized) || '无'}
        </span>
      </dd>
      <div className="mt-2 flex flex-wrap gap-2">
        {OUTPUT_FORMAT_OPTIONS.map((option) => {
          const checked = draft.includes(option.value)
          const allowToggleOff = draft.length > 1 || !checked
          return (
            <label
              key={option.value}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition ${
                checked
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--foreground))]'
                  : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))]'
              } ${disabled ? 'opacity-50' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || !allowToggleOff}
                onChange={() => {
                  setDraft((current) => current.includes(option.value)
                    ? current.filter((item) => item !== option.value)
                    : [...current, option.value],
                  )
                }}
                className="h-3.5 w-3.5 rounded border-[hsl(var(--border))] accent-[hsl(var(--primary))]"
              />
              <span>{option.label}</span>
            </label>
          )
        })}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
        用户端只会看到这里勾选的格式。至少保留一种，保存后立即生效。
      </p>
    </Card>
  )
}

function SettingCard({ label, value, unit, disabled, onEdit }: {
  label: string
  value: number
  unit: string
  disabled: boolean
  onEdit: () => void
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</dt>
        <Button variant="link" size="xs" disabled={disabled} onClick={onEdit}>
          修改
        </Button>
      </div>
      <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-sm text-[hsl(var(--muted-foreground))]">{unit}</span>
      </dd>
    </Card>
  )
}