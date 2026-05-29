import { useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthProvider'
import { deleteAvatar, logout, updateDisplayName, uploadAvatar, type AuthUser } from '../lib/auth'
import { openDestructiveConfirm, openPromptDialog, showAppToast } from '../lib/dialog'
import { formatBytes } from '../lib/format'
import { getUserFacingErrorMessage } from '../lib/userFacingText'
import Avatar from './Avatar'
import ModalShell from './ModalShell'
import { CloseIcon, EditIcon, PhotoIcon, TrashIcon } from './icons'

const MAX_AVATAR_BYTES = 5 * 1024 * 1024

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

interface Props {
  user: AuthUser
  onOpenGallery?: () => void
}

export default function UserMenu({ user, onOpenGallery }: Props) {
  const { refresh } = useAuth()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function closeModal() {
    setOpen(false)
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      showAppToast('请选择图片文件。', 'error')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      showAppToast('图片过大，请选择 5MB 以内的图片。', 'error')
      return
    }
    setBusy(true)
    try {
      const dataUrl = await fileToDataUrl(file)
      await uploadAvatar(dataUrl)
      await refresh()
      showAppToast('头像已更新。', 'success')
    } catch (err) {
      showAppToast(getUserFacingErrorMessage(err, '上传头像失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  function handleUploadClick() {
    closeModal()
    fileInputRef.current?.click()
  }

  function handleDeleteAvatar() {
    closeModal()
    openDestructiveConfirm({
      title: '删除头像',
      message: '确定移除当前头像吗？之后会显示首字母头像，可随时再上传。',
      confirmText: '删除',
      onConfirm: async () => {
        setBusy(true)
        try {
          await deleteAvatar()
          await refresh()
          showAppToast('头像已删除。', 'success')
        } catch (err) {
          showAppToast(getUserFacingErrorMessage(err, '删除头像失败'), 'error')
        } finally {
          setBusy(false)
        }
      },
    })
  }

  function handleEditDisplayName() {
    closeModal()
    openPromptDialog({
      title: '编辑显示名',
      message: '会显示在头像、共享画廊等位置。',
      defaultValue: user.displayName || user.username,
      placeholder: '平台显示名',
      validate: (value) => {
        const name = value.trim()
        if (!name) return '显示名不能为空。'
        if (name.length > 24) return '显示名最多 24 个字符。'
        return null
      },
      onConfirm: async (value) => {
        setBusy(true)
        try {
          await updateDisplayName(value)
          await refresh()
          showAppToast('显示名已更新。', 'success')
        } catch (err) {
          showAppToast(getUserFacingErrorMessage(err, '更新显示名失败'), 'error')
        } finally {
          setBusy(false)
        }
      },
    })
  }

  function handleOpenGallery() {
    closeModal()
    onOpenGallery?.()
  }

  function handleLogout() {
    closeModal()
    logout()
    window.location.reload()
  }

  const hasAvatar = user.avatarUpdatedAt != null
  const displayName = user.displayName || user.username
  const storagePercent = user.publicStorageQuotaBytes > 0
    ? Math.min(100, Math.round((user.publicStorageBytes / user.publicStorageQuotaBytes) * 100))
    : 0

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="账户菜单"
        className="rounded-full transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))] disabled:opacity-50"
      >
        <Avatar
          userId={user.userId}
          username={displayName}
          avatarUpdatedAt={user.avatarUpdatedAt}
          size={32}
        />
      </button>

      <ModalShell
        portal
        open={open}
        onClose={closeModal}
        paddingClass="p-3 sm:p-4"
        backdropClassName="bg-gray-950/25 backdrop-blur-md animate-overlay-in dark:bg-black/50"
        panelClassName="max-h-[calc(100dvh-1.5rem)] w-full max-w-[27rem] overflow-y-auto rounded-[1.75rem] border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(248,250,252,0.97)_100%)] shadow-[0_24px_70px_rgba(15,23,42,0.24)] ring-1 ring-black/[0.04] animate-modal-in dark:border-white/[0.08] dark:bg-[linear-gradient(180deg,rgba(17,24,39,0.98)_0%,rgba(9,9,11,0.97)_100%)] dark:ring-white/10"
      >
        <div className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-[hsl(var(--primary)/0.14)] via-emerald-500/10 to-transparent dark:from-[hsl(var(--primary)/0.18)] dark:via-emerald-400/10" />
          <button
            type="button"
            onClick={closeModal}
            className="absolute right-3 top-3 z-10 rounded-full p-2 text-gray-400 transition-colors hover:bg-white/80 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))] dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>

          <div className="relative flex flex-col items-center px-6 pb-5 pt-8 sm:px-7">
            <Avatar
              userId={user.userId}
              username={displayName}
              avatarUpdatedAt={user.avatarUpdatedAt}
              size={88}
              className="shadow-[0_14px_34px_rgba(15,23,42,0.18)] ring-[6px] ring-white/[0.85] dark:ring-white/[0.08]"
            />
            <div className="mt-4 flex max-w-full items-center gap-2">
              <h2 className="truncate text-2xl font-semibold leading-tight text-gray-950 dark:text-gray-50">
                {displayName}
              </h2>
              {user.isAdmin && (
                <span className="shrink-0 rounded-full border border-[hsl(var(--primary)/0.16)] bg-[hsl(var(--primary)/0.12)] px-2.5 py-1 text-[11px] font-semibold text-[hsl(var(--primary))] shadow-sm shadow-[hsl(var(--primary)/0.08)]">
                  管理员
                </span>
              )}
            </div>
            <p className="mt-2 max-w-full truncate rounded-full bg-white/75 px-3 py-1 text-sm font-medium text-[hsl(var(--muted-foreground))] shadow-sm ring-1 ring-black/[0.04] dark:bg-white/[0.06] dark:ring-white/10">
              @{user.username}
            </p>
          </div>

          <div className="relative grid grid-cols-2 gap-3 px-5 sm:px-6">
            <InfoTile
              label="并发上限"
              value={`${user.maxConcurrentPerUser} 个`}
              sub={`团队 ${user.maxConcurrent} 并发`}
              percent={100}
              tone="primary"
            />
            <InfoTile
              label="单次上限"
              value={`${user.maxBatchImages} 张`}
              sub="批量生成"
              percent={100}
              tone="primary"
            />
            <InfoTile
              label="共享画廊"
              value={`${user.publicGalleryCount} 张`}
              sub={`${formatBytes(user.publicStorageBytes)} / ${formatBytes(user.publicStorageQuotaBytes)}`}
              percent={storagePercent}
              tone="success"
              className="col-span-2"
            />
          </div>

          <div className={`grid gap-3 px-5 pt-4 sm:px-6 ${onOpenGallery ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <QuickAction icon={<EditIcon className="h-4 w-4" />} onClick={handleEditDisplayName}>
              编辑显示名
            </QuickAction>
            {onOpenGallery && (
              <QuickAction icon={<PhotoIcon className="h-4 w-4" />} onClick={handleOpenGallery}>
                我的共享
              </QuickAction>
            )}
          </div>

          <div className="mt-5 border-t border-gray-200/80 bg-white/[0.35] dark:border-white/10 dark:bg-white/[0.02]">
            <MenuRow
              icon={<PhotoIcon className="h-5 w-5" />}
              onClick={handleUploadClick}
            >
              {hasAvatar ? '更换头像' : '上传头像'}
            </MenuRow>
            {hasAvatar && (
              <MenuRow
                icon={<TrashIcon className="h-5 w-5" />}
                onClick={handleDeleteAvatar}
                destructive
              >
                删除头像
              </MenuRow>
            )}
          </div>

          <div className="border-t border-gray-200/80 bg-white/[0.35] dark:border-white/10 dark:bg-white/[0.02]">
            <MenuRow onClick={handleLogout} destructive>
              退出登录
            </MenuRow>
          </div>
        </div>
      </ModalShell>
    </>
  )
}

function MenuRow({
  children,
  onClick,
  icon,
  destructive = false,
}: {
  children: ReactNode
  onClick: () => void
  icon?: ReactNode
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-5 py-3.5 text-left text-sm font-medium transition-colors hover:bg-gray-100/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--primary))] sm:px-6 dark:hover:bg-white/[0.06] ${
        destructive
          ? 'text-red-600 dark:text-red-400'
          : 'text-gray-800 dark:text-gray-100'
      }`}
    >
      {icon && (
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
            destructive
              ? 'bg-red-500/10 text-red-500 dark:text-red-400'
              : 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'
          }`}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

function QuickAction({
  children,
  onClick,
  icon,
}: {
  children: ReactNode
  onClick: () => void
  icon?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-gray-200/80 bg-white/80 px-3 py-2.5 text-sm font-semibold text-gray-700 shadow-sm shadow-black/[0.03] transition hover:-translate-y-0.5 hover:border-[hsl(var(--primary)/0.24)] hover:bg-white hover:text-gray-950 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))] dark:border-white/10 dark:bg-white/[0.05] dark:text-gray-100 dark:shadow-black/20 dark:hover:bg-white/[0.08] dark:hover:text-white"
    >
      {icon && (
        <span className="text-gray-500 transition-colors group-hover:text-[hsl(var(--primary))] dark:text-gray-400">
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  )
}

function InfoTile({
  label,
  value,
  sub,
  percent,
  tone,
  className,
}: {
  label: string
  value: string
  sub: string
  percent: number
  tone: 'primary' | 'warning' | 'success'
  className?: string
}) {
  const clampedPercent = Math.max(0, Math.min(100, percent))
  const visualPercent = clampedPercent > 0 && clampedPercent < 5 ? 5 : clampedPercent
  const toneClass = {
    primary: {
      accent: 'bg-[hsl(var(--primary))]',
      pill: 'bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]',
    },
    warning: {
      accent: 'bg-amber-500',
      pill: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    success: {
      accent: 'bg-emerald-500',
      pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
  }[tone]

  return (
    <div className={`relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white/[0.78] p-4 shadow-sm shadow-black/[0.03] dark:border-white/10 dark:bg-white/[0.045] dark:shadow-black/20 ${className ?? ''}`}>
      <div className={`absolute inset-x-0 top-0 h-1 ${toneClass.accent}`} />
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">{label}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${toneClass.pill}`}>
          {clampedPercent}%
        </span>
      </div>
      <p className="mt-2 truncate text-[1.45rem] font-semibold leading-none text-gray-950 tabular-nums dark:text-gray-50">{value}</p>
      <p className="mt-2 truncate text-xs font-medium text-[hsl(var(--muted-foreground))]">{sub}</p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-200/80 dark:bg-white/10">
        <div
          className={`h-full rounded-full ${toneClass.accent} transition-[width]`}
          style={{ width: `${visualPercent}%` }}
        />
      </div>
    </div>
  )
}
