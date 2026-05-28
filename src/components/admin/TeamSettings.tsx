import { useState } from 'react'
import { fetchAdminTeamSettings, patchAdminTeamSettings } from '../../lib/adminApi'
import { openPromptDialog, showAppToast } from '../../lib/dialog'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import QueryState from './QueryState'

export default function TeamSettings() {
  const { data, loading, error, reload } = useAsyncQuery(() => fetchAdminTeamSettings(), [])
  const [saving, setSaving] = useState(false)

  function editDefaultHourlyQuota() {
    if (!data) return
    openPromptDialog({
      title: '默认小时额度',
      message: '仅影响新注册用户，已有用户保持各自额度。输入 0 表示默认暂停团队服务。',
      defaultValue: String(data.defaultHourlyImageQuota),
      inputType: 'number',
      validate: (raw) => {
        const quota = Number(raw)
        if (!Number.isFinite(quota) || quota < 0 || quota > 100000) return '请输入 0 到 100000 之间的数字。'
        return null
      },
      onConfirm: async (raw) => {
        setSaving(true)
        try {
          await patchAdminTeamSettings({ defaultHourlyImageQuota: Math.trunc(Number(raw)) })
          await reload()
          showAppToast('默认小时额度已更新。', 'success')
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
              <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">默认小时生图上限</h3>
              <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">新用户默认额度</p>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={editDefaultHourlyQuota}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[hsl(var(--border))] px-3 text-sm font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))] disabled:opacity-50"
            >
              修改
            </button>
          </div>

          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
              <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">额度</dt>
              <dd className="mt-1 flex items-baseline gap-1 text-[hsl(var(--foreground))]">
                <span className="text-2xl font-semibold tabular-nums">{data.defaultHourlyImageQuota}</span>
                <span className="text-sm text-[hsl(var(--muted-foreground))]">张 / 小时</span>
              </dd>
            </div>
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.22)] px-4 py-3">
              <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">状态</dt>
              <dd
                className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                  data.defaultHourlyImageQuota === 0
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'bg-green-500/10 text-green-600 dark:text-green-400'
                }`}
              >
                {data.defaultHourlyImageQuota === 0 ? '默认暂停' : '启用'}
              </dd>
            </div>
          </dl>
        </article>
      )}
    </QueryState>
  )
}
