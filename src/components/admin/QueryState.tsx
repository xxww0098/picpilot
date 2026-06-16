import type { ReactNode } from 'react'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'

interface QueryStateProps {
  loading: boolean
  error: string
  empty?: boolean
  emptyMessage?: string
  children: ReactNode
}

export default function QueryState({
  loading,
  error,
  empty = false,
  emptyMessage = '暂无数据',
  children,
}: QueryStateProps) {
  if (loading) return <p className="text-sm text-[hsl(var(--muted-foreground))]">加载中…</p>
  if (error) return <p className="text-sm text-red-500">{getUserFacingErrorMessage(error, '加载失败')}</p>
  if (empty) return <p className="text-sm text-[hsl(var(--muted-foreground))]">{emptyMessage}</p>
  return children
}
