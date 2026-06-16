import { useEffect, useMemo, useState } from 'react'
import { fetchAvatarBlob } from '../../lib/shared/auth'

interface Props {
  userId: string
  username: string
  avatarUpdatedAt: number | null
  size?: number
  className?: string
}

// Hash username → consistent hue for the fallback background.
function hueFromString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

function Initial({ username, hue, sizePx, fontSizePx }: { username: string; hue: number; sizePx: number; fontSizePx: number }) {
  const ch = username.trim().slice(0, 1).toUpperCase() || '?'
  return (
    <span
      aria-hidden
      className="flex items-center justify-center rounded-full font-semibold text-white select-none"
      style={{
        width: sizePx,
        height: sizePx,
        fontSize: fontSizePx,
        background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))`,
      }}
    >
      {ch}
    </span>
  )
}

export default function Avatar({ userId, username, avatarUpdatedAt, size = 32, className = '' }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const hue = useMemo(() => hueFromString(username || userId), [username, userId])
  const fontSize = Math.max(10, Math.round(size * 0.42))

  useEffect(() => {
    if (avatarUpdatedAt == null || !userId) {
      setUrl(null)
      setFailed(false)
      return
    }
    let aborted = false
    let objectUrl: string | null = null
    setFailed(false)
    fetchAvatarBlob(userId)
      .then((blob) => {
        if (aborted) return
        if (!blob) {
          setFailed(true)
          return
        }
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!aborted) setFailed(true)
      })
    return () => {
      aborted = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [userId, avatarUpdatedAt])

  const showFallback = avatarUpdatedAt == null || failed || !url
  if (showFallback) {
    return (
      <div className={className} style={{ width: size, height: size }}>
        <Initial username={username} hue={hue} sizePx={size} fontSizePx={fontSize} />
      </div>
    )
  }

  return (
    <img
      src={url}
      alt={username}
      width={size}
      height={size}
      className={`rounded-full object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
