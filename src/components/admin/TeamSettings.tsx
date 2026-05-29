import { useState } from 'react'
import { fetchAdminTeamSettings, patchAdminTeamSettings } from '../../lib/adminApi'
import { openPromptDialog, showAppToast } from '../../lib/dialog'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import QueryState from './QueryState'

export default function TeamSettings() {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchAdminTeamSettings(), [])
  const [saving, setSaving] = useState(false)

  function editDefaultMaxBatch() {
    if (!data) return
    openPromptDialog({
      title: '默认批量上限',
      message: '仅影响新注册用户，已有用户保持各自上限。范围 1-100。',
      defaultValue: String(data.defaultMaxBatchImages),
      inputType: 'number',
      validate: (raw) => {
        const val = Number(raw)
        if (!Number.isFinite(val) || val < 1 || val > 100) return '请输入 1 到 100 之间的数字。'
        return null
      },
      onConfirm: async (raw) => {
        setSaving(true)
        try {
          await patchAdminTeamSettings({ defaultMaxBatchImages: Math.trunc(Number(raw)) })
          await reload()
          showAppToast('默认批量上限已更新。', 'success')
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
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">团队服务配置</h3>
              <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">并发控制与批量限制</p>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={editDefaultMaxBatch}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[hsl(var(--border))] px-3 text-sm font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))] disabled:opacity-50"
            >
              修改批量上限
            </button>
          </div>

          <dl className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
              <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">团队并发</dt>
              <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
                <span className="text-2xl font-semibold tabular-nums">{data.maxConcurrent}</span>
                <span className="text-sm text-[hsl(var(--muted-foreground))]">个请求</span>
              </dd>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
              <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">每人并发</dt>
              <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
                <span className="text-2xl font-semibold tabular-nums">{data.maxConcurrentPerUser}</span>
                <span className="text-sm text-[hsl(var(--muted-foreground))]">个请求</span>
              </dd>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
              <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">默认批量上限</dt>
              <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
                <span className="text-2xl font-semibold tabular-nums">{data.defaultMaxBatchImages}</span>
                <span className="text-sm text-[hsl(var(--muted-foreground))]">张 / 次</span>
              </dd>
            </div>
          </dl>
        </article>
      )}
    </QueryState>
  )
}
