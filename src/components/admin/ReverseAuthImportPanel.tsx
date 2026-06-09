import { useMemo, useState } from 'react'
import {
  fetchAdminReverseAuthCLIProxyAccounts,
  importAdminReverseAuthCLIProxyAccounts,
  importAdminReverseAuthSub2APIAccounts,
  type AdminReverseAuthCLIProxyAccount,
  type AdminReverseAuthImportResponse,
  type AdminReverseAuthImportSkipped,
} from '../../lib/adminApi'
import { showAppToast } from '../../lib/dialog'
import { getUserFacingErrorMessage } from '../../lib/userFacingText'

interface ReverseAuthImportPanelProps {
  disabled: boolean
  onImported: () => Promise<void> | void
}

export default function ReverseAuthImportPanel({ disabled, onImported }: ReverseAuthImportPanelProps) {
  const [cpaLoading, setCpaLoading] = useState(false)
  const [cpaImporting, setCpaImporting] = useState(false)
  const [cpaAccounts, setCpaAccounts] = useState<AdminReverseAuthCLIProxyAccount[]>([])
  const [cpaSearch, setCpaSearch] = useState('')
  const [selectedCPA, setSelectedCPA] = useState<Set<string>>(() => new Set())
  const [sub2BaseUrl, setSub2BaseUrl] = useState('')
  const [sub2AdminToken, setSub2AdminToken] = useState('')
  const [sub2Search, setSub2Search] = useState('')
  const [sub2Status, setSub2Status] = useState('')
  const [sub2Importing, setSub2Importing] = useState(false)
  const [lastSkipped, setLastSkipped] = useState<AdminReverseAuthImportSkipped[]>([])

  const filteredCPAAccounts = useMemo(() => {
    const q = cpaSearch.trim().toLowerCase()
    if (!q) return cpaAccounts
    return cpaAccounts.filter((account) => (
      [account.name, account.provider ?? '', account.type ?? ''].some((value) => value.toLowerCase().includes(q))
    ))
  }, [cpaAccounts, cpaSearch])

  const selectedFilteredCount = filteredCPAAccounts.filter((account) => selectedCPA.has(account.name)).length
  const selectedCount = selectedCPA.size
  const allFilteredSelected = filteredCPAAccounts.length > 0 && selectedFilteredCount === filteredCPAAccounts.length

  async function loadCPAAccounts() {
    setCpaLoading(true)
    try {
      const result = await fetchAdminReverseAuthCLIProxyAccounts()
      setCpaAccounts(result.accounts)
      setSelectedCPA(new Set(result.accounts.map((account) => account.name)))
      setLastSkipped([])
      showAppToast(`已读取 ${result.accounts.length} 个 CPA 账号。`, 'success')
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '读取 CPA 账号失败'), 'error')
    } finally {
      setCpaLoading(false)
    }
  }

  function toggleCPAAccount(name: string) {
    setSelectedCPA((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleFilteredCPAAccounts() {
    setSelectedCPA((current) => {
      const next = new Set(current)
      if (allFilteredSelected) {
        for (const account of filteredCPAAccounts) next.delete(account.name)
      } else {
        for (const account of filteredCPAAccounts) next.add(account.name)
      }
      return next
    })
  }

  async function importSelectedCPAAccounts() {
    if (selectedCount === 0) {
      showAppToast('请选择要导入的 CPA 账号。', 'info')
      return
    }
    setCpaImporting(true)
    try {
      const result = await importAdminReverseAuthCLIProxyAccounts(Array.from(selectedCPA))
      handleImportResult('CPA', result)
      await onImported()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导入 CPA 账号失败'), 'error')
    } finally {
      setCpaImporting(false)
    }
  }

  async function importSub2APIAccounts() {
    const baseUrl = sub2BaseUrl.trim()
    if (!baseUrl) {
      showAppToast('请填写 sub2api 服务器地址。', 'info')
      return
    }
    setSub2Importing(true)
    try {
      const result = await importAdminReverseAuthSub2APIAccounts({
        baseUrl,
        adminToken: sub2AdminToken.trim(),
        search: sub2Search.trim(),
        status: sub2Status,
      })
      handleImportResult('sub2api', result)
      await onImported()
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '导入 sub2api 账号失败'), 'error')
    } finally {
      setSub2Importing(false)
    }
  }

  function handleImportResult(source: string, result: AdminReverseAuthImportResponse) {
    setLastSkipped(result.skipped)
    const message = `${source} 导入 ${result.imported.length} 个账号${result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : ''}。`
    showAppToast(message, result.imported.length > 0 ? 'success' : 'info')
  }

  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[hsl(var(--foreground))]">远程导入</h4>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            从已配置的 CPA 服务器筛选账号，或从 sub2api 拉取 OpenAI OAuth 账号。
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || cpaLoading}
          onClick={() => void loadCPAAccounts()}
          className="rounded border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cpaLoading ? '读取中...' : '读取 CPA 账号'}
        </button>
      </div>

      {cpaAccounts.length > 0 && (
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
                value={cpaSearch}
                onChange={(event) => setCpaSearch(event.target.value)}
                placeholder="筛选名称、provider、类型"
                className="h-8 w-56 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
              />
              <span className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))]">
                已选 {selectedCount} / {cpaAccounts.length}
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
                        checked={selectedCPA.has(account.name)}
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

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_auto] lg:items-end">
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
          <span className="mb-1 block">sub2api 地址</span>
          <input
            value={sub2BaseUrl}
            disabled={disabled || sub2Importing}
            onChange={(event) => setSub2BaseUrl(event.target.value)}
            placeholder="https://sub2api.example.com"
            className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
          <span className="mb-1 block">管理令牌</span>
          <input
            value={sub2AdminToken}
            disabled={disabled || sub2Importing}
            type="password"
            onChange={(event) => setSub2AdminToken(event.target.value)}
            placeholder="Bearer / API Key"
            className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
            <span className="mb-1 block">搜索</span>
            <input
              value={sub2Search}
              disabled={disabled || sub2Importing}
              onChange={(event) => setSub2Search(event.target.value)}
              placeholder="plus"
              className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
            <span className="mb-1 block">状态</span>
            <select
              value={sub2Status}
              disabled={disabled || sub2Importing}
              onChange={(event) => setSub2Status(event.target.value)}
              className="h-9 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm text-[hsl(var(--foreground))] outline-none focus:border-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
              <option value="invalid">invalid</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled={disabled || sub2Importing || sub2BaseUrl.trim() === ''}
          onClick={() => void importSub2APIAccounts()}
          className="h-9 rounded bg-[hsl(var(--primary))] px-3 text-sm font-medium text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sub2Importing ? '导入中...' : '导入 sub2api'}
        </button>
      </div>

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
