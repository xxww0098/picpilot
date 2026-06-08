import { useState } from 'react'
import { fetchAdminTeamSettings, patchAdminTeamSettings } from '../../lib/adminApi'
import { openPromptDialog, showAppToast } from '../../lib/dialog'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import { useAuth } from '../../contexts/AuthProvider'
import QueryState from './QueryState'

export default function TeamSettings() {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchAdminTeamSettings(), [])
  const { patchUser } = useAuth()
  const [saving, setSaving] = useState(false)

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
          patchUser({
            maxBatchImages: updated.defaultMaxBatchImages,
            galleryAutoRetryCount: updated.galleryAutoRetryCount,
            maxConcurrent: updated.maxConcurrent,
            maxQueue: updated.maxQueue,
            proxyUserSoftLimit: updated.proxyUserSoftLimit,
            streamFallbackEnabled: updated.streamFallbackEnabled,
            requestTimeoutSeconds: updated.requestTimeoutSeconds,
          })
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
      patchUser({
        maxBatchImages: updated.defaultMaxBatchImages,
        galleryAutoRetryCount: updated.galleryAutoRetryCount,
        maxConcurrent: updated.maxConcurrent,
        maxQueue: updated.maxQueue,
        proxyUserSoftLimit: updated.proxyUserSoftLimit,
        streamFallbackEnabled: updated.streamFallbackEnabled,
        requestTimeoutSeconds: updated.requestTimeoutSeconds,
      })
      await reload()
      showAppToast(updated.streamFallbackEnabled ? '流式失败回退已开启。' : '流式失败回退已关闭。', 'success')
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
          </dl>
        </article>
      )}
    </QueryState>
  )
}

function BooleanSettingCard({ label, enabled, disabled, onToggle }: {
  label: string
  enabled: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
      <div className="flex items-center justify-between">
        <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</dt>
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          className="text-xs font-medium text-[hsl(var(--primary))] transition-colors hover:underline disabled:opacity-50"
        >
          切换
        </button>
      </div>
      <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
        <span className="text-2xl font-semibold">{enabled ? '开启' : '关闭'}</span>
      </dd>
    </div>
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
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
      <div className="flex items-center justify-between">
        <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</dt>
        <button
          type="button"
          disabled={disabled}
          onClick={onEdit}
          className="text-xs font-medium text-[hsl(var(--primary))] transition-colors hover:underline disabled:opacity-50"
        >
          修改
        </button>
      </div>
      <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-sm text-[hsl(var(--muted-foreground))]">{unit}</span>
      </dd>
    </div>
  )
}
