import { useState, useRef, useEffect } from 'react'
import { login } from '../../lib/shared/auth'
import { getUserFacingErrorMessage } from '../../lib/shared/userFacingText'
import AuthShell, {
  AuthDivider,
  AuthError,
  AuthField,
  AuthLinkButton,
  AuthLockIcon,
  AuthPasswordField,
  AuthSubmitButton,
  AuthUserIcon,
} from './AuthShell'

interface Props {
  onSuccess: () => void
  onSwitchToRegister?: () => void
}

export default function LoginModal({ onSuccess, onSwitchToRegister }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    usernameRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username || !password || loading) return
    setError('')
    setLoading(true)
    try {
      await login(username, password)
      onSuccess()
    } catch (err) {
      setError(getUserFacingErrorMessage(err, '登录失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell title="登录" subtitle="开始生图与编辑">
      <form onSubmit={(e) => void handleSubmit(e)} className="flex w-full flex-col gap-3.5">
        <AuthField
          ref={usernameRef}
          label="用户名"
          icon={<AuthUserIcon />}
          type="text"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <AuthPasswordField
          label="密码"
          icon={<AuthLockIcon />}
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <AuthError message={error} />}
        <AuthSubmitButton loading={loading} loadingLabel="登录中…" disabled={!username || !password}>
          登录
        </AuthSubmitButton>
        {onSwitchToRegister && (
          <>
            <AuthDivider />
            <AuthLinkButton onClick={onSwitchToRegister}>邀请码注册</AuthLinkButton>
          </>
        )}
      </form>
    </AuthShell>
  )
}
