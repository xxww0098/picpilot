import { useState, useRef, useEffect } from 'react'
import { register } from '../lib/shared/auth'
import { getUserFacingErrorMessage } from '../lib/shared/userFacingText'
import AuthShell, {
  AuthDivider,
  AuthError,
  AuthField,
  AuthLinkButton,
  AuthLockIcon,
  AuthPasswordField,
  AuthSubmitButton,
  AuthTicketIcon,
  AuthUserIcon,
} from './auth/AuthShell'

interface Props {
  initialInvite?: string
  onSuccess: () => void
  onSwitchToLogin: () => void
}

export default function RegisterModal({ initialInvite, onSuccess, onSwitchToLogin }: Props) {
  const [invite, setInvite] = useState(initialInvite ?? '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!invite || !username || !password || loading) return
    setError('')
    setLoading(true)
    try {
      await register(invite.trim(), username.trim(), password)
      onSuccess()
    } catch (err) {
      setError(getUserFacingErrorMessage(err, '注册失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell title="注册账号" subtitle="用邀请码创建账号">
      <form onSubmit={(e) => void handleSubmit(e)} className="flex w-full flex-col gap-3.5">
        <AuthField
          ref={firstFieldRef}
          label="邀请码"
          icon={<AuthTicketIcon />}
          type="text"
          placeholder="邀请码"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          autoComplete="off"
        />
        <AuthField
          label="用户名"
          icon={<AuthUserIcon />}
          type="text"
          placeholder="2-32 个字符"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <AuthPasswordField
          label="密码"
          icon={<AuthLockIcon />}
          placeholder="至少 6 位"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        {error && <AuthError message={error} />}
        <AuthSubmitButton
          loading={loading}
          loadingLabel="注册中…"
          disabled={!invite || !username || !password}
        >
          注册
        </AuthSubmitButton>
        <AuthDivider />
        <AuthLinkButton onClick={onSwitchToLogin}>返回登录</AuthLinkButton>
      </form>
    </AuthShell>
  )
}
