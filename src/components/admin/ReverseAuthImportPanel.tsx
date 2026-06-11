import { useEffect, useMemo, useState } from 'react'
import {
  fetchAdminReverseAuthCLIProxyAccounts,
  fetchAdminReverseAuthImportSources,
  importAdminReverseAuthCLIProxyAccounts,
  importAdminReverseAuthSub2APIAccounts,
  saveAdminReverseAuthImportSources,
  type AdminReverseAuthCLIProxyAccount,
  type AdminReverseAuthImportResponse,
  type AdminReverseAuthImportSkipped,
  type AdminReverseAuthImportSource,
  type AdminReverseAuthImportSourceType,
} from '../../lib/adminApi'
import { showAppToast } from '../../lib/dialog'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'

interface ReverseAuthImportPanelProps {
  disabled: boolean
  onImported: () => Promise<void> | void
}

type Sub2Filter = {
  search: string
  status: string
}

type CPAAccountState = {
  sourceId: string
  sourceName: string
  accounts: AdminReverseAuthCLIProxyAccount[]
  selected: Set<string>
  search: string
}

export default function ReverseAuthImportPanel({ disabled, onImported }: ReverseAuthImportPanelProps) {
  const [sources, setSources] = useState<AdminReverseAuthImportSource[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourcesSaving, setSourcesSaving] = useState(false)
  const [cpaLoadingSourceId, setCpaLoadingSourceId] = useState<string | null>(null)
  const [cpaImporting, setCpaImporting] = useState(false)
  const [cpaState, setCpaState] = useState<CPAAccountState | null>(null)
  const [sub2Filters, setSub2Filters] = useState<Record<string, Sub2Filter>>({})
  const [sub2ImportingSourceId, setSub2ImportingSourceId] = useState<string | null>(null)
  const [lastSkipped, setLastSkipped] = useState<AdminReverseAuthImportSkipped[]>([])

  useEffect(() => {
    let cancelled = false
    setSourcesLoading(true)
    fetchAdminReverseAuthImportSources()
      .then((result) => {
        if (!cancelled) setSources(result.sources)
      })
      .catch((err) => {
        if (!cancelled) showAppToast(getUserFacingErrorMessage(err, '读取导入来源失败'), 'error')
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filteredCPAAccounts = useMemo(() => {
    const accounts = cpaState?.accounts ?? []
    const q = cpaState?.search.trim().toLowerCase() ?? ''
    if (!q) return accounts
    return accounts.filter((account) => (
      [account.name, account.provider ?? '', account.type ?? ''].some((value) => value.toLowerCase().includes(q))
    ))
  }, [cpaState])

  const selectedFilteredCount = filteredCPAAccounts.filter((account) => cpaState?.selected.has(account.name)).length
  const selectedCount = cpaState?.selected.size ?? 0
  const allFilteredSelected = filteredCPAAccounts.length > 0 && selectedFilteredCount === filteredCPAAccounts.length

  function addSource(type: AdminReverseAuthImportSourceType) {
    const id = `source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    setSources((items) => ([
      ...items,
      {
        id,
        type,
        name: type === 'cpa' ? 'CPA' : 'Sub2API',
        baseUrl: '',
        managementKeyConfigured: false,
      },
    ]))
  }

  function updateSource(id: string, patch: Partial<AdminReverseAuthImportSource>) {
    setSources((items) => items.map((source) => source.id === id ? { ...source, ...patch } : source))
  }

  function removeSource(id: string) {
    setSources((items) => items.filter((source) => source.id !== id))
    setCpaState((state) => state?.sourceId === id ? null : state)
  }

  async function saveSources(silent = false) {
    setSourcesSaving(true)
    try {
      const result = await saveAdminReverseAuthImportSources(
        sources.map((source) => ({
          ...source,
          name: source.name.trim(),
          baseUrl: source.baseUrl.trim(),
          managementKey: source.managementKey?.trim() || undefined,
        })),
      )
      setSources(result.sources)
      if (!silent) showAppToast('导入来源已保存。', 'success')
      return result.sources
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '保存导入来源失败'), 'error')
      return null
    } finally {
      setSourcesSaving(false)
    }
  }

  async function saveAndResolveSource(source: AdminReverseAuthImportSource) {
    if (!source.baseUrl.trim()) {
      showAppToast('请填写导入来源地址。', 'info')
      return null
    }
    if (!source.managementKeyConfigured && !source.managementKey?.trim()) {
      showAppToast('请填写管理令牌。', 'info')
      return null
    }
    const savedSources = await saveSources(true)
    return savedSources?.find((item) => item.id === source.id) ?? null
  }

  async function loadCPAAccounts(source: AdminReverseAuthImportSource) {
    const savedSource = await saveAndResolveSource(source)
    if (!savedSource) return
    setCpaLoadingSourceId(savedSource.id)
    try {
      const result = await fetchAdminReverseAuthCLIProxyAccounts(savedSource.id)
      setCpaState({
        sourceId: savedSource.id,
        sourceName: savedSource.name,
        accounts: result.accounts,
        selected: new Set(result.accounts.map((account) => account.name)),
        search: '',
      })
      setLastSkipped([])
      showAppToast(`已读取 ${result.accounts.length} 个 CPA 账号。`, 'success')
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '读取 CPA 账号失败'), 'error')
    } finally {
      setCpaLoadingSourceId(null)
    }
  }

  function toggleCPAAccount(name: string) {
    setCpaState((state) => {
      if (!state) return state
      const selected = new Set(state.selected)
      if (selected.has(name)) selected.delete(name)
      else selected.add(name)
      return { ...state, selected }
    })
  }

  function toggleFilteredCPAAccounts() {
    setCpaState((state) => {
      if (!state) return state
      const selected = new Set(state.selected)
      if (allFilteredSelected) {
        for (const account of filteredCPAAccounts) selected.delete(account.name)
      } else {
        for (const account of filteredCPAAccounts) selected.add(account.name)
      }
      return { ...state, selected }
    })
  }

  async function importSelectedCPAAccounts() {
    if (!cpaState || cpaState.selected.size === 0) {
      showAppToast('请选择要导入的 CPA 账号。', 'info')
      return
    }
    setCpaImporting(true)
    try {
      const result = await importAdminReverseAuthCLIProxyAccounts(Array.from(cpaState.selected), cpaState.sourceId)
      handleImportResult(cpaState.sourceName, result)
      await onImported()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导入 CPA 账号失败'), 'error')
    } finally {
      setCpaImporting(false)
    }
  }

  async function importSub2APIAccounts(source: AdminReverseAuthImportSource) {
    const savedSource = await saveAndResolveSource(source)
    if (!savedSource) return
    const filter = sub2Filters[source.id] ?? { search: '', status: '' }
    setSub2ImportingSourceId(savedSource.id)
    try {
      const result = await importAdminReverseAuthSub2APIAccounts({
        sourceId: savedSource.id,
        baseUrl: savedSource.baseUrl,
        search: filter.search.trim(),
        status: filter.status,
      })
      handleImportResult(savedSource.name, result)
      await onImported()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导入 Sub2API 账号失败'), 'error')
    } finally {
      setSub2ImportingSourceId(null)
    }
  }

  function handleImportResult(sourceName: string, result: AdminReverseAuthImportResponse) {
    setLastSkipped(result.skipped)
    const message = `${sourceName} 导入 ${result.imported.length} 个账号${result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : ''}。`
    showAppToast(message, result.imported.length > 0 ? 'success' : 'info')
  }

  function setSub2Filter(sourceId: string, patch: Partial<Sub2Filter>) {
    setSub2Filters((items) => ({
      ...items,
      [sourceId]: { ...(items[sourceId] ?? { search: '', status: '' }), ...patch },
    }))
  }

  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[hsl(var(--foreground))]">导入来源</h4>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            保存 CPA 和 Sub2API 地址，读取账号后导入到内置 reverse。同名导入会覆盖已存在的逆向账号信息，并清空旧检查结果和路由统计。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled || sourcesLoading}
            onClick={() => addSource('cpa')}
            className="h-8 rounded border border-[hsl(var(--border))] px-2.5 text-xs font-medium transition hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            添加 CPA
          </button>
          <button
            type="button"
            disabled={disabled || sourcesLoading}
            onClick={() => addSource('sub2api')}
            className="h-8 rounded border border-[hsl(var(--border))] px-2.5 text-xs font-medium transition hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            添加 Sub2API
          </button>
          <button
            type="button"
            disabled={disabled || sourcesLoading || sourcesSaving}
            onClick={() => void saveSources()}
            className="h-8 rounded bg-[hsl(var(--primary))] px-3 text-xs font-medium text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sourcesSaving ? '保存中...' : '保存来源'}
          </button>
        </div>
      </div>

      {sourcesLoading ? (
        <p className="mt-4 rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
          正在读取导入来源...
        </p>
      ) : sources.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
          还没有导入来源。添加 CPA 或 Sub2API 后保存。
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
          {sources.map((source) => {
            const sub2Filter = sub2Filters[source.id] ?? { search: '', status: '' }
            const keyPlaceholder = source.managementKeyConfigured ? '已保存，留空保留' : '管理令牌'
            return (
              <div key={source.id} className="border-b border-[hsl(var(--border))] p-3 last:border-0">
                <div className="grid gap-3 lg:grid-cols-[7rem_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_auto] lg:items-end">
                  <div>
                    <span className={`inline-flex h-8 items-center rounded border px-2.5 text-xs font-semibold ${
                      source.type === 'cpa'
                        ? 'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        : 'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                    }`}
                    >
                      {source.type === 'cpa' ? 'CPA' : 'Sub2API'}
                    </span>
                  </div>
                  <label className="min-w-0 text-xs font-medium text-[hsl(var(--muted-foreground))]">
                    <span className="mb-1 block">名称</span>
                    <input
                      value={source.name}
                      disabled={disabled || sourcesSaving}
                      onChange={(event) => updateSource(source.id, { name: event.target.value })}
                      className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 text-sm text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="min-w-0 text-xs font-medium text-[hsl(var(--muted-foreground))]">
                    <span className="mb-1 block">地址</span>
                    <input
                      value={source.baseUrl}
                      disabled={disabled || sourcesSaving}
                      onChange={(event) => updateSource(source.id, { baseUrl: event.target.value })}
                      placeholder={source.type === 'cpa' ? 'https://cpa.example.com' : 'https://sub2api.example.com'}
                      className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="min-w-0 text-xs font-medium text-[hsl(var(--muted-foreground))]">
                    <span className="mb-1 block">管理令牌</span>
                    <input
                      value={source.managementKey ?? ''}
                      disabled={disabled || sourcesSaving}
                      type="password"
                      onChange={(event) => updateSource(source.id, { managementKey: event.target.value })}
                      placeholder={keyPlaceholder}
                      className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <div className="flex flex-wrap justify-end gap-2">
                    {source.type === 'cpa' ? (
                      <button
                        type="button"
                        aria-label={`读取 ${source.name || 'CPA'}`}
                        disabled={disabled || cpaLoadingSourceId === source.id || sourcesSaving}
                        onClick={() => void loadCPAAccounts(source)}
                        className="h-9 rounded border border-[hsl(var(--border))] px-3 text-sm font-medium transition hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {cpaLoadingSourceId === source.id ? '读取中...' : '读取账号'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`导入 ${source.name || 'Sub2API'}`}
                        disabled={disabled || sub2ImportingSourceId === source.id || sourcesSaving}
                        onClick={() => void importSub2APIAccounts(source)}
                        className="h-9 rounded bg-[hsl(var(--primary))] px-3 text-sm font-medium text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {sub2ImportingSourceId === source.id ? '导入中...' : '导入'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={disabled || sourcesSaving}
                      onClick={() => removeSource(source.id)}
                      className="h-9 rounded border border-rose-500/30 px-3 text-sm font-medium text-rose-600 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-rose-300"
                    >
                      删除
                    </button>
                  </div>
                </div>
                {source.type === 'sub2api' && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <input
                      value={sub2Filter.search}
                      disabled={disabled || sub2ImportingSourceId === source.id}
                      onChange={(event) => setSub2Filter(source.id, { search: event.target.value })}
                      placeholder="搜索账号名，可留空"
                      className="h-8 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 text-xs text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <select
                      value={sub2Filter.status}
                      disabled={disabled || sub2ImportingSourceId === source.id}
                      onChange={(event) => setSub2Filter(source.id, { status: event.target.value })}
                      className="h-8 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-xs text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">全部状态</option>
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                      <option value="invalid">invalid</option>
                    </select>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {cpaState && (
        <div className="mt-4 rounded-lg border border-[hsl(var(--border))]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleFilteredCPAAccounts}
                className="size-4 rounded border-[hsl(var(--border))]"
              />
              全选筛选结果
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={cpaState.search}
                onChange={(event) => setCpaState((state) => state ? { ...state, search: event.target.value } : state)}
                placeholder={`筛选 ${cpaState.sourceName}`}
                className="h-8 w-56 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
              />
              <span className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))]">
                已选 {selectedCount} / {cpaState.accounts.length}
              </span>
              <button
                type="button"
                disabled={disabled || cpaImporting || selectedCount === 0}
                onClick={() => void importSelectedCPAAccounts()}
                className="h-8 rounded bg-[hsl(var(--primary))] px-3 text-xs font-medium text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cpaImporting ? '导入中...' : '导入所选'}
              </button>
            </div>
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[hsl(var(--background))]">
                <tr className="border-b border-[hsl(var(--border))] text-left text-xs text-[hsl(var(--muted-foreground))]">
                  <th className="w-10 px-3 py-2"></th>
                  <th className="py-2 pr-3">名称</th>
                  <th className="py-2 pr-3">Provider</th>
                  <th className="py-2 pr-3">类型</th>
                </tr>
              </thead>
              <tbody>
                {filteredCPAAccounts.map((account) => (
                  <tr key={account.name} className="border-b border-[hsl(var(--border))] last:border-0">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={cpaState.selected.has(account.name)}
                        onChange={() => toggleCPAAccount(account.name)}
                        className="size-4 rounded border-[hsl(var(--border))]"
                      />
                    </td>
                    <td className="py-2 pr-3 font-medium text-[hsl(var(--foreground))]">{account.name}</td>
                    <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{account.provider || 'openai'}</td>
                    <td className="py-2 pr-3 text-[hsl(var(--muted-foreground))]">{account.type || 'oauth'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredCPAAccounts.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">没有符合筛选条件的 CPA 账号。</p>
            )}
          </div>
        </div>
      )}

      {lastSkipped.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <div className="font-medium">最近跳过 {lastSkipped.length} 个账号</div>
          <ul className="mt-1 max-h-24 overflow-auto space-y-1">
            {lastSkipped.slice(0, 8).map((item) => (
              <li key={`${item.name}:${item.reason}`}>{item.name}: {item.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
