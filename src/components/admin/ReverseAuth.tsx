import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  bulkDeleteAdminReverseAuthAccounts,
  deleteAdminReverseAuthAccount,
  downloadAdminReverseAuthAccounts,
  fetchAdminReverseAuthAccount,
  fetchAdminReverseAuthCheckJob,
  fetchAdminReverseAuth,
  importAdminReverseAuthAccessToken,
  startAdminReverseAuthCheckJob,
  updateAdminReverseAuthAccount,
  uploadAdminReverseAuthAccount,
  type AdminReverseAuthCheckJob,
  type AdminReverseAuthCheckResult,
  type AdminReverseAuthCheckStatus,
  type AdminReverseAuthAccount,
} from '../../lib/adminApi'
import { openDestructiveConfirm, openPromptDialog, showAppToast } from '../../lib/dialog'
import { formatBytes, formatRelative } from '../../lib/format'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'
import { useAsyncQuery } from '../../hooks/useAsyncQuery'
import QueryState from './QueryState'
import ReverseAuthEditModal from './ReverseAuthEditModal'
import ReverseAuthImportPanel from './ReverseAuthImportPanel'

export default function ReverseAuth() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { data, loading, error, reload } = useAsyncQuery(fetchAdminReverseAuth, [])
  const [uploading, setUploading] = useState(false)
  const [importingToken, setImportingToken] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [deletingName, setDeletingName] = useState<string | null>(null)
  const [loadingEditName, setLoadingEditName] = useState<string | null>(null)
  const [editingAccount, setEditingAccount] = useState<ReverseAuthEditState | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [checking, setChecking] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [checkResults, setCheckResults] = useState<AdminReverseAuthCheckResult[]>([])
  const [checkJob, setCheckJob] = useState<AdminReverseAuthCheckJob | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<AccountStatusFilter>('all')
  const checkByName = useMemo(() => new Map(checkResults.map((result) => [result.name, result])), [checkResults])
  const accountRows = useMemo(() => (
    data?.accounts.map((account) => ({
      account,
      check: getAccountCheckSnapshot(account, checkByName.get(account.name)),
    })) ?? []
  ), [checkByName, data?.accounts])
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return accountRows.filter(({ account, check }) => {
      if (statusFilter !== 'all') {
        if (statusFilter === 'unchecked') {
          if (check.status) return false
        } else if (check.status !== statusFilter) {
          return false
        }
      }
      if (!q) return true
      return [
        account.name,
        account.email ?? '',
        account.userId ?? '',
        check.accountType ?? '',
        check.status ?? '',
        check.reason ?? '',
      ].some((value) => value.toLowerCase().includes(q))
    })
  }, [accountRows, searchQuery, statusFilter])
  const quotaLimitedNames = accountRows
    .filter(({ check }) => check.status === 'quota_or_rate_limited')
    .map(({ account }) => account.name)

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      showAppToast('请选择 .json 文件。', 'error')
      return
    }
    setUploading(true)
    try {
      await uploadAdminReverseAuthAccount(file)
      showAppToast('逆向账号已导入数据库。', 'success')
      await reload()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导入 reverse 账号失败'), 'error')
    } finally {
      setUploading(false)
    }
  }

  async function handleExportAccounts() {
    setExporting(true)
    try {
      await downloadAdminReverseAuthAccounts()
      showAppToast('逆向账号已导出。', 'success')
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导出 reverse 账号失败'), 'error')
    } finally {
      setExporting(false)
    }
  }

  function promptImportAccessToken() {
    openPromptDialog({
      title: '导入 access_token',
      message: '粘贴 ChatGPT OAuth access_token。导入后可通过“检查额度”识别邮箱、登录态和剩余额度。',
      inputType: 'password',
      placeholder: 'eyJ...',
      validate: (value) => {
        const token = value.trim()
        if (!token) return '请填写 access_token。'
        if (token.length > 2 * 1024 * 1024) return 'access_token 过大，请控制在 2MB 以内。'
        return null
      },
      onConfirm: async (accessToken) => {
        setImportingToken(true)
        try {
          await importAdminReverseAuthAccessToken({ accessToken, name: 'access-token' })
          showAppToast('access_token 已导入。', 'success')
          await reload()
        } catch (err) {
          showAppToast(getUserFacingErrorMessage(err, '导入 access_token 失败'), 'error')
        } finally {
          setImportingToken(false)
        }
      },
    })
  }

  async function openEditAccount(account: AdminReverseAuthAccount) {
    setLoadingEditName(account.name)
    try {
      const detail = await fetchAdminReverseAuthAccount(account.name)
      setEditingAccount({ account: detail.account, rawJson: detail.rawJson })
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '加载 reverse 账号 JSON 失败'), 'error')
    } finally {
      setLoadingEditName(null)
    }
  }

  async function saveEditedAccount(rawJson: string) {
    if (!editingAccount) return
    const name = editingAccount.account.name
    setSavingEdit(true)
    try {
      await updateAdminReverseAuthAccount(name, rawJson)
      setCheckResults((items) => items.filter((item) => item.name !== name))
      setEditingAccount(null)
      showAppToast('逆向账号 JSON 已保存。', 'success')
      await reload()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '保存 reverse 账号失败'), 'error')
    } finally {
      setSavingEdit(false)
    }
  }

  function confirmDelete(account: AdminReverseAuthAccount) {
    openDestructiveConfirm({
      title: '删除逆向账号',
      message: `确定删除「${account.name}」吗？删除后该 ChatGPT 账号不会再参与内置 reverse 路由。`,
      confirmText: '删除',
      onConfirm: async () => {
        setDeletingName(account.name)
        try {
          await deleteAdminReverseAuthAccount(account.name)
          showAppToast('逆向账号已删除。', 'success')
          await reload()
        } catch (err) {
          showAppToast(getUserFacingErrorMessage(err, '删除 reverse 账号失败'), 'error')
        } finally {
          setDeletingName(null)
        }
      },
    })
  }

  async function handleCheckAccounts(names?: string[]) {
    setChecking(true)
    try {
      let job = (await startAdminReverseAuthCheckJob(names)).job
      setCheckJob(job)
      setCheckResults(job.results)
      while (job.status === 'running') {
        await delay(1000)
        job = (await fetchAdminReverseAuthCheckJob(job.id)).job
        setCheckJob(job)
        setCheckResults(job.results)
      }
      if (job.status === 'failed') {
        showAppToast(job.error || '检查 reverse 账号失败', 'error')
      } else {
        showCheckSummary(job.results)
      }
      await reload()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '检查 reverse 账号失败'), 'error')
    } finally {
      setChecking(false)
    }
  }

  async function handleCheckFilteredAccounts() {
    const names = filteredRows.map(({ account }) => account.name)
    if (names.length === 0) {
      showAppToast('当前筛选结果为空，无需刷新。', 'info')
      return
    }
    await handleCheckAccounts(names)
  }

  function confirmBulkDeleteNoQuota() {
    if (quotaLimitedNames.length === 0) {
      showAppToast('没有检查结果为“疑似无额度”的账号。', 'info')
      return
    }
    openDestructiveConfirm({
      title: '删除无额度账号',
      message: `将删除 ${quotaLimitedNames.length} 个检查结果为“疑似无额度”的账号。删除后这些账号不会再参与 reverse 路由。`,
      confirmText: '删除',
      onConfirm: async () => {
        setBulkDeleting(true)
        try {
          const result = await bulkDeleteAdminReverseAuthAccounts(quotaLimitedNames)
          setCheckResults((items) => items.filter((item) => !result.deleted.includes(item.name)))
          showAppToast(`已删除 ${result.deleted.length} 个逆向账号。`, 'success')
          await reload()
        } catch (err) {
          showAppToast(getUserFacingErrorMessage(err, '批量删除 reverse 账号失败'), 'error')
        } finally {
          setBulkDeleting(false)
        }
      },
    })
  }

  return (
    <QueryState loading={loading} error={error}>
      {data && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[hsl(var(--foreground))]">逆向账号</h3>
              <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                导入 ChatGPT OAuth JSON 到数据库，供 Go 内置 reverse 读取。普通用户只需要在 API 配置里选择逆向模式。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))]"
              >
                刷新
              </button>
              <button
                type="button"
                disabled={!data.configured || checking}
                onClick={() => void handleCheckAccounts()}
                title="读取 ChatGPT Web image_gen 剩余额度，识别登录态失效和无额度账号。"
                className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checking ? progressButtonText(checkJob) : '检查额度'}
              </button>
              <button
                type="button"
                disabled={!data.configured || exporting}
                onClick={() => void handleExportAccounts()}
                className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {exporting ? '导出中...' : '导出 JSON'}
              </button>
              <button
                type="button"
                disabled={quotaLimitedNames.length === 0 || bulkDeleting}
                onClick={confirmBulkDeleteNoQuota}
                className="rounded border border-rose-500/30 px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-rose-300"
              >
                {bulkDeleting ? '删除中...' : `删除无额度${quotaLimitedNames.length ? ` (${quotaLimitedNames.length})` : ''}`}
              </button>
              <button
                type="button"
                disabled={!data.configured || uploading}
                onClick={() => fileInputRef.current?.click()}
                className="rounded bg-[hsl(var(--primary))] px-3 py-1.5 text-sm font-medium text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? '导入中...' : '导入 JSON'}
              </button>
              <button
                type="button"
                disabled={!data.configured || importingToken}
                onClick={promptImportAccessToken}
                className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importingToken ? '导入中...' : '导入 Token'}
              </button>
            </div>
          </div>

          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void handleFileChange(event)} />

          <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatusTile label="存储位置" value="SQLite 数据库" />
              <StatusTile label="写入状态" value={data.configured ? '可导入' : '未初始化'} tone={data.configured ? 'success' : 'warning'} />
              <StatusTile label="已导入账号" value={`${data.accounts.length} 个`} />
            </div>
            {data.message && (
              <p className="mt-4 rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]">
                {data.message}
              </p>
            )}
            {checkJob && (
              <CheckJobProgress job={checkJob} />
            )}
            <p className="mt-4 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
              导入内容会写入服务器 SQLite 数据库，不会保存为服务器文件。JSON 中必须包含 <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5">access_token</code>；
              建议同时保留 <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5">refresh_token</code>，便于服务端自动续期。也可以直接粘贴 access_token 导入为临时账号，但无法自动续期。列表不会展示原始 JSON；只有点击编辑或导出时才会返回到当前管理员浏览器。
            </p>
          </section>

          <ReverseAuthImportPanel
            disabled={!data.configured}
            onImported={async () => {
              await reload()
            }}
          />

          <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-[hsl(var(--foreground))]">已导入账号</h4>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  显示上次检查持久结果；手动检查后会自动刷新列表。
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索名称、邮箱、状态"
                  className="h-8 w-48 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                />
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as AccountStatusFilter)}
                  className="h-8 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                >
                  {ACCOUNT_STATUS_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <span className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))]">
                  {filteredRows.length} / {data.accounts.length} 个
                </span>
                <button
                  type="button"
                  disabled={!data.configured || checking || filteredRows.length === 0}
                  onClick={() => void handleCheckFilteredAccounts()}
                  className="h-8 rounded border border-[hsl(var(--border))] px-2.5 text-xs font-medium transition hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  刷新筛选结果
                </button>
              </div>
            </div>

            {data.accounts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
                还没有 reverse 账号。点击右上角“导入 JSON”添加。
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[hsl(var(--border))] text-left text-xs text-[hsl(var(--muted-foreground))]">
                      <th className="py-2 pr-3">名称</th>
                      <th className="py-2 pr-3">账号</th>
                      <th className="py-2 pr-3">续期</th>
                      <th className="py-2 pr-3">状态 / 额度</th>
                      <th className="py-2 pr-3">最近检查</th>
                      <th className="py-2 pr-3 text-right">大小</th>
                      <th className="py-2 pr-3">更新</th>
                      <th className="py-2 pl-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(({ account, check }) => (
                      <tr key={account.name} className="border-b border-[hsl(var(--border))] last:border-0">
                        <td className="py-2 pr-3 font-medium text-[hsl(var(--foreground))]">{account.name}</td>
                        <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">
                          <div>{account.email || '未标注'}</div>
                          {account.userId && <div className="mt-0.5 max-w-[12rem] truncate text-xs">{account.userId}</div>}
                        </td>
                        <td className="py-2 pr-3">
                          <RefreshBadge account={account} />
                        </td>
                        <td className="py-2 pr-3">
                          <CheckCell check={check} />
                        </td>
                        <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">
                          {check.checkedAt ? formatRelative(check.checkedAt) : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{formatBytes(account.size)}</td>
                        <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{formatRelative(account.modifiedAt)}</td>
                        <td className="py-2 pl-3 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              disabled={loadingEditName === account.name || deletingName === account.name}
                              onClick={() => void openEditAccount(account)}
                              className="rounded border border-[hsl(var(--border))] px-2.5 py-1 text-xs font-medium transition hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {loadingEditName === account.name ? '读取中...' : '编辑'}
                            </button>
                            <button
                              type="button"
                              disabled={deletingName === account.name}
                              onClick={() => confirmDelete(account)}
                              className="rounded border border-rose-500/30 px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-rose-300"
                            >
                              {deletingName === account.name ? '删除中...' : '删除'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredRows.length === 0 && (
                  <p className="border-t border-[hsl(var(--border))] px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
                    没有符合当前筛选条件的账号。
                  </p>
                )}
              </div>
            )}
          </section>

          {editingAccount && (
            <ReverseAuthEditModal
              account={editingAccount.account}
              rawJson={editingAccount.rawJson}
              saving={savingEdit}
              onClose={() => {
                if (!savingEdit) setEditingAccount(null)
              }}
              onSave={(rawJson) => void saveEditedAccount(rawJson)}
            />
          )}
        </div>
      )}
    </QueryState>
  )
}

type ReverseAuthEditState = {
  account: AdminReverseAuthAccount
  rawJson: string
}

function showCheckSummary(results: AdminReverseAuthCheckResult[]) {
  const counts = results.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1
    return acc
  }, {})
  const quotaCount = counts.quota_or_rate_limited ?? 0
  const okCount = counts.ok ?? 0
  const knownQuota = results.reduce((sum, item) => (
    item.status === 'ok' && !item.imageQuotaUnknown && typeof item.quota === 'number' ? sum + item.quota : sum
  ), 0)
  const unknownQuotaCount = results.filter((item) => item.status === 'ok' && item.imageQuotaUnknown).length
  const quotaText = unknownQuotaCount > 0 ? `已知剩余额度 ${knownQuota}，未知 ${unknownQuotaCount} 个` : `剩余额度 ${knownQuota}`
  showAppToast(`检查完成：可用 ${okCount} 个，${quotaText}，无额度 ${quotaCount} 个。`, quotaCount > 0 ? 'error' : 'success')
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function progressButtonText(job: AdminReverseAuthCheckJob | null) {
  if (!job) return '检查中...'
  if (job.total > 0) return `检查中 ${job.completed}/${job.total}`
  return `检查中 ${job.completed}`
}

function CheckJobProgress({ job }: { job: AdminReverseAuthCheckJob }) {
  const pct = job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0
  const statusText = job.status === 'running'
    ? '正在刷新账号状态'
    : job.status === 'succeeded'
      ? '账号状态已刷新'
      : '刷新失败'
  const detail = job.total > 0 ? `${job.completed} / ${job.total}` : `${job.completed} 个已完成`
  return (
    <div className="mt-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.35)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-[hsl(var(--foreground))]">{statusText}</span>
        <span className="tabular-nums text-[hsl(var(--muted-foreground))]">{detail}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[hsl(var(--border))]">
        <div
          className="h-full rounded-full bg-[hsl(var(--primary))] transition-[width] duration-200"
          style={{ width: job.total > 0 ? `${pct}%` : '12%' }}
        />
      </div>
      {job.error && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">{job.error}</p>
      )}
    </div>
  )
}

type AccountStatusFilter = 'all' | 'unchecked' | AdminReverseAuthCheckStatus

type AccountCheckSnapshot = {
  status?: AdminReverseAuthCheckStatus
  reason?: string
  httpStatus?: number
  checkedAt?: number
  accountType?: string
  quota?: number
  imageQuotaUnknown?: boolean
  restoreAt?: string
  defaultModelSlug?: string
}

const ACCOUNT_STATUS_FILTERS: Array<{ value: AccountStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'ok', label: '可用' },
  { value: 'quota_or_rate_limited', label: '无额度/限流' },
  { value: 'expired', label: '登录失效' },
  { value: 'invalid', label: '无效' },
  { value: 'disabled', label: '已禁用' },
  { value: 'error', label: '检查失败' },
  { value: 'unchecked', label: '未检查' },
]

function getAccountCheckSnapshot(account: AdminReverseAuthAccount, result?: AdminReverseAuthCheckResult): AccountCheckSnapshot {
  if (result) {
    return {
      status: result.status,
      reason: result.reason,
      httpStatus: result.httpStatus,
      checkedAt: result.checkedAt,
      accountType: result.type,
      quota: result.quota,
      imageQuotaUnknown: result.imageQuotaUnknown,
      restoreAt: result.restoreAt,
      defaultModelSlug: result.defaultModelSlug,
    }
  }
  return {
    status: account.status,
    reason: account.statusReason,
    httpStatus: account.httpStatus,
    checkedAt: account.lastCheckedAt,
    accountType: account.accountType,
    quota: account.quota,
    imageQuotaUnknown: account.imageQuotaUnknown,
    restoreAt: account.restoreAt,
    defaultModelSlug: account.defaultModelSlug,
  }
}

function StatusTile({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'success' | 'warning' }) {
  const valueClass = tone === 'success'
    ? 'text-emerald-600 dark:text-emerald-300'
    : tone === 'warning'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-[hsl(var(--foreground))]'
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-2">
      <div className="text-xs text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className={`mt-1 truncate text-sm font-medium ${valueClass}`} title={value}>{value}</div>
    </div>
  )
}

function RefreshBadge({ account }: { account: AdminReverseAuthAccount }) {
  if (account.disabled) return <Badge tone="warning">已禁用</Badge>
  if (account.hasRefreshToken && account.hasPasswordLogin) return <Badge tone="success">可续期/重登</Badge>
  if (account.hasRefreshToken) return <Badge tone="success">可续期</Badge>
  if (account.hasPasswordLogin) return <Badge tone="success">可重登</Badge>
  return <Badge tone="warning">仅 access token</Badge>
}

function CheckCell({ check }: { check: AccountCheckSnapshot }) {
  const badge = <CheckBadge check={check} />
  if (!check.status) return badge
  const parts = [
    check.accountType ? check.accountType.toUpperCase() : '',
    formatCheckQuota(check),
    check.restoreAt ? `恢复 ${formatRestoreAt(check.restoreAt)}` : '',
  ].filter(Boolean)
  return (
    <div>
      {badge}
      {parts.length > 0 && (
        <div className="mt-1 max-w-[16rem] truncate text-xs text-[hsl(var(--muted-foreground))]" title={parts.join(' · ')}>
          {parts.join(' · ')}
        </div>
      )}
    </div>
  )
}

function CheckBadge({ check }: { check: AccountCheckSnapshot }) {
  if (!check.status) return <Badge tone="neutral">未检查</Badge>
  const quota = formatCheckQuota(check)
  const title = [
    check.reason,
    check.accountType ? `套餐 ${check.accountType}` : '',
    quota ? `额度 ${quota}` : '',
    check.restoreAt ? `恢复 ${formatRestoreAt(check.restoreAt)}` : '',
    check.defaultModelSlug ? `默认模型 ${check.defaultModelSlug}` : '',
    check.httpStatus ? `HTTP ${check.httpStatus}` : '',
    check.checkedAt ? `检查于 ${formatRelative(check.checkedAt)}` : '',
  ].filter(Boolean).join(' · ')
  switch (check.status) {
    case 'ok':
      return <Badge tone="success" title={title}>{quota ? `可用 ${quota}` : '可用'}</Badge>
    case 'quota_or_rate_limited':
      return <Badge tone="danger" title={title}>无额度</Badge>
    case 'expired':
      return <Badge tone="danger" title={title}>登录失效</Badge>
    case 'invalid':
      return <Badge tone="danger" title={title}>无效</Badge>
    case 'disabled':
      return <Badge tone="warning" title={title}>已禁用</Badge>
    default:
      return <Badge tone="warning" title={title}>检查失败</Badge>
  }
}

function formatCheckQuota(check: Pick<AccountCheckSnapshot, 'imageQuotaUnknown' | 'quota'>) {
  if (check.imageQuotaUnknown) return '未知'
  if (typeof check.quota === 'number') return String(check.quota)
  return ''
}

function formatRestoreAt(value: string) {
  const ts = Date.parse(value)
  if (Number.isFinite(ts)) return new Date(ts).toLocaleString()
  return value
}

function Badge({ children, tone, title }: { children: ReactNode; tone: 'success' | 'warning' | 'danger' | 'neutral'; title?: string }) {
  const cls = tone === 'success'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : tone === 'danger'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
      : tone === 'neutral'
        ? 'border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  return <span title={title} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>
}
