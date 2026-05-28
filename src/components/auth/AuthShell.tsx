import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import ModalShell from '../ModalShell'

const AUTH_INPUT_BASE =
  'h-11 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.45)] py-0 pl-10 text-sm text-[hsl(var(--foreground))] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))] focus:bg-[hsl(var(--background))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]'

export const AUTH_INPUT_CLASS = `${AUTH_INPUT_BASE} pr-4`

const AUTH_PASSWORD_INPUT_CLASS = `${AUTH_INPUT_BASE} pr-10`

export const AUTH_PRIMARY_BUTTON_CLASS =
  'relative mt-0.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 text-sm font-semibold text-[hsl(var(--primary-foreground))] shadow-md shadow-[hsl(var(--primary)/0.25)] transition-[opacity,box-shadow,transform] hover:shadow-lg hover:shadow-[hsl(var(--primary)/0.3)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100'

const AUTH_FEATURES = [
  {
    icon: (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 21" />
      </svg>
    ),
    text: '生图、参考图、遮罩',
  },
  {
    icon: (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    text: '多服务商接口',
  },
  {
    icon: (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    ),
    text: '历史与设置本地保存',
  },
] as const

interface AuthShellProps {
  title: string
  subtitle?: string
  children: ReactNode
}

export default function AuthShell({ title, subtitle, children }: AuthShellProps) {
  return (
    <ModalShell
      closeOnEscape={false}
      backdropCloseMode="none"
      zIndexClass="z-50"
      paddingClass="safe-area-x p-4 sm:p-6"
      className="overflow-y-auto"
      backdropClassName="auth-backdrop backdrop-blur-[2px] animate-overlay-in"
      panelClassName="animate-modal-in w-full max-w-[54rem]"
    >
      <div className="grid overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-2xl shadow-black/10 ring-1 ring-black/5 dark:shadow-black/50 dark:ring-white/5 md:min-h-[30rem] md:grid-cols-[0.96fr_1.04fr]">
        <aside className="relative hidden overflow-hidden md:flex md:flex-col md:items-center md:justify-center md:p-8 lg:p-10">
          <div
            className="absolute inset-0 bg-gradient-to-br from-[hsl(var(--primary))] via-[hsl(var(--primary)/0.92)] to-[hsl(221_70%_42%)]"
            aria-hidden
          />

          <div className="relative text-center">
            <img
              src="./pwa-icon-192.png"
              alt=""
              width={52}
              height={52}
              className="mx-auto mb-5 h-[3.25rem] w-[3.25rem] rounded-2xl shadow-lg shadow-black/20 ring-1 ring-white/20"
              aria-hidden
            />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">PicPilot</p>
            <h2 className="mt-3 text-2xl font-semibold leading-snug tracking-tight text-white">
              AI 商品图工作台
            </h2>
            <p className="mx-auto mt-3 max-w-[13rem] text-sm leading-relaxed text-white/75">
              生图、编辑、历史一处完成。
            </p>
          </div>

          <ul className="relative mt-9 w-full max-w-[16rem] space-y-3">
            {AUTH_FEATURES.map((feature) => (
              <li key={feature.text} className="flex items-center gap-3 text-sm leading-snug text-white/90">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15">{feature.icon}</span>
                <span>{feature.text}</span>
              </li>
            ))}
          </ul>
        </aside>

        <div className="relative flex flex-1 flex-col">
          <div
            className="h-1 bg-gradient-to-r from-[hsl(var(--primary)/0.15)] via-[hsl(var(--primary))] to-[hsl(var(--primary)/0.15)] md:hidden"
            aria-hidden
          />

          <div className="flex flex-1 items-center justify-center px-6 py-8 sm:px-8 md:px-10">
            <div className="mx-auto flex w-full max-w-[23rem] flex-col justify-center">
              <div className="mb-5 flex flex-col items-center text-center">
                <div className="mb-4 flex items-center justify-center gap-3 md:hidden">
                  <img
                    src="./pwa-icon-192.png"
                    alt=""
                    width={44}
                    height={44}
                    className="h-11 w-11 rounded-xl shadow-md shadow-[hsl(var(--primary)/0.3)] ring-1 ring-black/5 dark:ring-white/10"
                    aria-hidden
                  />
                  <div>
                    <p className="text-[0.65rem] font-semibold tracking-[0.15em] text-[hsl(var(--muted-foreground))]">
                      PicPilot
                    </p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">AI 商品图工作台</p>
                  </div>
                </div>

                <h1 className="text-xl font-semibold tracking-tight text-[hsl(var(--foreground))] sm:text-2xl">
                  {title}
                </h1>
                {subtitle && (
                  <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">{subtitle}</p>
                )}

                <div className="mt-4 flex flex-wrap justify-center gap-2 md:hidden">
                  {AUTH_FEATURES.map((feature) => (
                    <span
                      key={feature.text}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.5)] px-2.5 text-[0.6875rem] text-[hsl(var(--muted-foreground))]"
                    >
                      {feature.icon}
                      <span className="max-w-[9rem] truncate">{feature.text}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="w-full">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string
  icon: ReactNode
}

export const AuthField = forwardRef<HTMLInputElement, AuthFieldProps>(function AuthField(
  { label, icon, id, ...inputProps },
  ref,
) {
  const fieldId = id ?? label
  return (
    <label htmlFor={fieldId} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]">
          {icon}
        </span>
        <input ref={ref} id={fieldId} className={AUTH_INPUT_CLASS} {...inputProps} />
      </div>
    </label>
  )
})

export const AuthPasswordField = forwardRef<HTMLInputElement, AuthFieldProps>(function AuthPasswordField(
  { label, icon, id, ...inputProps },
  ref,
) {
  const [visible, setVisible] = useState(false)
  const fieldId = id ?? label

  return (
    <label htmlFor={fieldId} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]">
          {icon}
        </span>
        <input
          ref={ref}
          id={fieldId}
          type={visible ? 'text' : 'password'}
          className={AUTH_PASSWORD_INPUT_CLASS}
          {...inputProps}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))]"
          aria-label={visible ? '隐藏密码' : '显示密码'}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </label>
  )
})

export function AuthError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-600 dark:text-red-400"
    >
      <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path strokeLinecap="round" d="M12 8v4m0 4h.01" />
      </svg>
      <span className="text-left leading-snug">{message}</span>
    </div>
  )
}

export function AuthSubmitButton({
  loading,
  loadingLabel,
  children,
  disabled,
}: {
  loading: boolean
  loadingLabel: string
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <button type="submit" disabled={disabled || loading} className={AUTH_PRIMARY_BUTTON_CLASS}>
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      )}
      {loading ? loadingLabel : children}
    </button>
  )
}

export function AuthLinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-center text-sm text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--primary))]"
    >
      {children}
    </button>
  )
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3 py-0.5" aria-hidden>
      <div className="h-px flex-1 bg-[hsl(var(--border))]" />
      <span className="text-[0.65rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">或</span>
      <div className="h-px flex-1 bg-[hsl(var(--border))]" />
    </div>
  )
}

function UserIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path strokeLinecap="round" d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  )
}

export function AuthUserIcon() {
  return <UserIcon />
}

export function AuthLockIcon() {
  return <LockIcon />
}

export function AuthTicketIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 5v2M9 5v2M5 9h14M5 15h14M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3l18 18M10.58 10.58A3 3 0 0012 15a3 3 0 002.42-4.42M9.88 4.24A10.94 10.94 0 0112 5c6.5 0 10 7 10 7a18.43 18.43 0 01-4.06 5.06M6.1 6.1C3.28 8.02 2 12 2 12s3.5 7 10 7a10.8 10.8 0 004.24-.88"
      />
    </svg>
  )
}
