# picpilot — Agent 指南

面向在本仓库中改代码的 AI Agent 的约定与速查。

## 用户对话框（必读）

**禁止**使用浏览器原生 `window.alert`、`window.confirm`、`window.prompt`。统一走 `src/lib/dialog.ts`，由全局 `ConfirmDialog`、`PromptDialog`、`Toast` 渲染。

| 场景 | 使用 |
|------|------|
| 普通确认（可取消） | `openConfirmDialog({ title, message, onConfirm, tone?, confirmText?, cancelText? })` |
| 删除 / 吊销等危险操作 | `openDestructiveConfirm({ title, message, onConfirm, confirmText? })` |
| 需要用户输入（密码、数字等） | `openPromptDialog({ title, message?, defaultValue?, inputType?, placeholder?, validate?, onConfirm })` |
| 操作结果、错误、复制成功等轻提示 | `showAppToast(message, 'success' \| 'error' \| 'info')` |

示例：

```ts
import { openDestructiveConfirm, openPromptDialog, showAppToast } from '../lib/dialog'

openDestructiveConfirm({
  title: '删除公开图',
  message: '确定删除吗？删除后其他成员将无法在画廊中看到它。',
  onConfirm: async () => { /* ... */ },
})

openPromptDialog({
  title: '重置密码',
  message: '至少 6 位',
  inputType: 'password',
  validate: (v) => (v.length < 6 ? '新密码至少需要 6 位。' : null),
  onConfirm: async (pwd) => { /* ... */ },
})

showAppToast('邀请链接已复制', 'success')
```

说明：

- `onConfirm` 可为 `async`；确认/输入弹窗会在用户点击确认后关闭，异步逻辑在回调内自行处理错误并用 `showAppToast(..., 'error')` 反馈。
- 不要直接调用 `useStore.getState().setConfirmDialog` / `setPromptDialog`，除非需要 `ConfirmDialog` 的高级能力（复选框、自定义按钮、`minConfirmDelayMs` 等）；常规场景用 `dialog.ts` 即可。
- PWA 安装的 `BeforeInstallPromptEvent.prompt()` 是浏览器安装 API，与 `window.prompt` 无关，可继续使用。

相关组件：`src/components/ConfirmDialog.tsx`、`src/components/PromptDialog.tsx`、`src/components/Toast.tsx`（已在 `App.tsx` 挂载）。

## 其他约定

- 面向用户的错误文案用 `getUserFacingErrorMessage`（`src/lib/userFacingText.ts`）；Toast 错误类型会经 store 做简短化处理。
- 未明确要求时不要提交 `data/auth.db` 等本地运行时文件。
- 仅在被明确要求时创建 git commit。
