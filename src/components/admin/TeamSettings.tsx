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

  return (
    <QueryState loading={loading} error={error}>
      {data && (
        <article className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
          <div>
            <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">团队服务配置</h3>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">并发控制、批量限制与失败补重试（修改即时生效，无需重启）</p>
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
          </dl>
        </article>
      )}
    </QueryState>
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
