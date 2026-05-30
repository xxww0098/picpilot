import { useState, type ReactNode } from 'react'
import { useAuth } from '../../contexts/AuthProvider'
import { useStore } from '../../store'
import { formatBytes } from '../../lib/format'
import { showAppToast } from '../../lib/dialog'
import { CopyIcon } from '../icons'

// 「关于」设置页：应用标识 + 结合当前功能（服务能力、账户、本地数据）的运行状态概览。
export default function SettingsAboutSection() {
  const { user } = useAuth()
  const taskCount = useStore((s) => s.tasks.length)
  const conversationCount = useStore((s) => s.agentConversations.length)
  const [copied, setCopied] = useState(false)

  const version = __APP_VERSION__
  const storagePercent =
    user && user.publicStorageQuotaBytes > 0
      ? Math.min(100, Math.round((user.publicStorageBytes / user.publicStorageQuotaBytes) * 100))
      : 0

  async function copyDiagnostics() {
    const lines = [
      `picpilot v${version}`,
      user ? `账户: ${user.displayName || user.username} (@${user.username})` : '账户: 未登录',
      user ? `角色: ${user.isAdmin ? '管理员' : '成员'}` : null,
      user ? `服务并发: ${user.maxConcurrent} · 排队上限: ${user.maxQueue} · 单次批量: ${user.maxBatchImages}` : null,
      user ? `共享画廊: ${user.publicGalleryCount} 张 · ${formatBytes(user.publicStorageBytes)} / ${formatBytes(user.publicStorageQuotaBytes)}` : null,
      `本地任务: ${taskCount} · 对话: ${conversationCount}`,
      `UA: ${navigator.userAgent}`,
    ].filter(Boolean)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      showAppToast('诊断信息已复制。', 'success')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      showAppToast('复制失败，请手动选择文本。', 'error')
    }
  }

  return (
    <div className="space-y-5 pb-4">
      {/* 标识 */}
      <div className="flex flex-col items-center pt-2">
        <div className="mb-4 flex h-[76px] w-[76px] items-center justify-center rounded-2xl border border-gray-200/80 bg-gradient-to-br from-gray-50 to-white text-gray-800 shadow-sm dark:border-white/[0.08] dark:from-white/[0.04] dark:to-transparent dark:text-gray-100">
          <svg className="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        </div>
        <div className="flex items-center gap-2">
          <h4 className="text-[17px] font-bold text-gray-800 dark:text-gray-100">picpilot</h4>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
            v{version}
          </span>
        </div>
        <p className="mt-1.5 text-[13px] text-gray-500 dark:text-gray-400">自部署的 AI 图像生成与 Agent 平台</p>
      </div>

      {/* 账户 */}
      {user && (
        <Card title="账户">
          <Row label="登录账户">
            <span className="truncate">{user.displayName || user.username}</span>
            <span className="ml-1.5 text-gray-400 dark:text-gray-500">@{user.username}</span>
          </Row>
          <Row label="账户角色">
            {user.isAdmin ? (
              <span className="rounded-full bg-[hsl(var(--primary)/0.12)] px-2 py-0.5 text-[11px] font-semibold text-[hsl(var(--primary))]">
                管理员
              </span>
            ) : (
              <span className="text-gray-600 dark:text-gray-300">成员</span>
            )}
          </Row>
        </Card>
      )}

      {/* 服务能力（团队配置生效值） */}
      {user && (
        <Card title="服务能力">
          <Row label="服务并发">{user.maxConcurrent} 个</Row>
          <Row label="排队上限">{user.maxQueue} 个</Row>
          <Row label="单次批量上限">{user.maxBatchImages} 张 / 次</Row>
          <Row label="共享画廊">
            <span className="tabular-nums">{user.publicGalleryCount} 张</span>
            <span className="ml-2 text-gray-400 dark:text-gray-500">
              {formatBytes(user.publicStorageBytes)} / {formatBytes(user.publicStorageQuotaBytes)}（{storagePercent}%）
            </span>
          </Row>
        </Card>
      )}

      {/* 本地数据 */}
      <Card title="本地数据">
        <Row label="任务记录">{taskCount} 条</Row>
        <Row label="Agent 对话">{conversationCount} 个</Row>
        <p className="px-4 pb-3 pt-1 text-xs leading-relaxed text-gray-400 dark:text-gray-500">
          本地优先：配置、任务与图片默认仅存于本浏览器，可在「数据管理」导出备份或清理。
        </p>
      </Card>

      <button
        type="button"
        onClick={() => void copyDiagnostics()}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
      >
        <CopyIcon className="h-4 w-4" />
        {copied ? '已复制诊断信息' : '复制诊断信息'}
      </button>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-white/[0.06] dark:bg-white/[0.02]">
      <div className="border-b border-gray-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:border-white/[0.06] dark:text-gray-500">
        {title}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-white/[0.04]">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="flex min-w-0 items-center justify-end truncate text-right font-medium text-gray-800 dark:text-gray-100">
        {children}
      </span>
    </div>
  )
}
