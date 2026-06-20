import { useCallback, useEffect, useState } from 'react'
import {
  estimateStorageUsage,
  getStorageCounts,
  requestPersistentStorage,
  scanStorageIntegrity,
  type StorageCounts,
  type StorageEstimateInfo,
} from '../../lib/shared/db'
import { showAppToast } from '../../lib/ui/dialog'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const ACTION_BTN =
  'rounded-xl bg-gray-100/80 px-3 py-2 text-xs font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white'

// 存储健康面板：用户的任务/图片只存浏览器 IndexedDB，浏览器在存储压力下可能静默清理非持久化数据。
// 这里向用户暴露用量、持久化状态，并提供「申请持久化 / 完整性扫描」两个自检手段。完全自包含，
// 直接调用 db.ts，不经父组件透传。
export default function StorageHealthPanel() {
  const [info, setInfo] = useState<StorageEstimateInfo | null>(null)
  const [counts, setCounts] = useState<StorageCounts | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [est, c] = await Promise.all([estimateStorageUsage(), getStorageCounts()])
      setInfo(est)
      setCounts(c)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onRequestPersist = useCallback(async () => {
    const granted = await requestPersistentStorage()
    showAppToast(
      granted ? '已开启持久化存储，浏览器不会自动清理这些数据。' : '当前浏览器拒绝或不支持持久化存储。',
      granted ? 'success' : 'info',
    )
    await refresh()
  }, [refresh])

  const onScan = useCallback(async () => {
    setScanning(true)
    try {
      const report = await scanStorageIntegrity()
      if (report.corrupted.length === 0) {
        const note = report.missingThumbnails > 0 ? `（${report.missingThumbnails} 张缺缩略图，可自动补全）` : ''
        showAppToast(`完整性检查通过：${report.totalImages} 张图片均正常${note}。`, 'success')
      } else {
        showAppToast(`发现 ${report.corrupted.length} 张图片数据已损坏（共 ${report.totalImages} 张），建议从备份恢复。`, 'error')
      }
    } catch {
      showAppToast('完整性检查失败。', 'error')
    } finally {
      setScanning(false)
    }
  }, [])

  const percent = info ? Math.min(100, Math.round(info.percentUsed)) : 0
  const quotaKnown = Boolean(info && info.quotaBytes > 0)

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] space-y-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">存储健康</h4>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            info?.persisted
              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
          }`}
        >
          {info?.persisted ? '已持久化' : '未持久化'}
        </span>
      </div>

      {quotaKnown ? (
        <>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/[0.08]">
            <div
              className={`h-full rounded-full transition-all ${percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-amber-500' : 'bg-blue-500'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="text-[13px] text-gray-500 dark:text-gray-400">
            已用 {formatBytes(info!.usageBytes)} / 共 {formatBytes(info!.quotaBytes)}（{percent}%）
          </div>
        </>
      ) : (
        <div className="text-[13px] text-gray-500 dark:text-gray-400">当前浏览器未提供用量估算。</div>
      )}

      {counts && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] text-gray-600 dark:text-gray-400 sm:grid-cols-4">
          <span>图片 {counts.images}</span>
          <span>视频 {counts.videos}</span>
          <span>任务 {counts.tasks}</span>
          <span>对话 {counts.agentConversations}</span>
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-gray-400 dark:text-gray-500">
        未持久化时浏览器可能在空间紧张时清理这些数据；建议开启持久化，并定期导出备份。
      </p>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => void refresh()} disabled={loading} className={ACTION_BTN}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        {info && !info.persisted && (
          <button onClick={() => void onRequestPersist()} className={ACTION_BTN}>
            申请持久化
          </button>
        )}
        <button onClick={() => void onScan()} disabled={scanning} className={ACTION_BTN}>
          {scanning ? '扫描中…' : '完整性扫描'}
        </button>
      </div>
    </div>
  )
}
