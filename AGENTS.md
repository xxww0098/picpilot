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

## 日志路径（排查线上问题用）

部署在 `/opt/picpilot`（`compose.yml`，服务名 `auth`/`frontend`/`cliproxy`/`caddy`/`dockercopilot`）。

| 组件 | 位置 | 查看方式 |
|------|------|---------|
| picpilot 后端（`server/index.ts`，pino） | 输出到 stdout，无文件 | `docker logs picpilot-auth-1`（加 `-f`/`--tail 200`/`--since 1h`） |
| picpilot 前端（静态资源 / nginx） | stdout | `docker logs picpilot-frontend-1` |
| CLIProxyAPI（上游出图代理） | `/opt/picpilot/data/cliproxy/logs/` | `main.log` 为主日志（含每个请求路由账号与耗时）；`error-*.log` 为单请求错误快照（请求头 + 上游响应） |
| Caddy（反代/TLS） | stdout | `docker logs picpilot-caddy-1` |

排查"出图慢"时看 `cliproxy` 的 `main.log`：每个 `/v1/images/edits` 完成行带耗时（如 `200 | 5m40s |`）和请求 id，可用 id 反查路由的 OAuth 账号 / API key 与是否回退。后端代理（`/api-proxy/*`）只设**一个全局并发上限** `MAX_CONCURRENT_PROXY_REQUESTS`，超出的请求进入 **FIFO 排队等待**（实现见 `server/concurrencyQueue.ts`，`acquire`/`release` 为抽象边界）；队列长度/等待超时由 `PROXY_QUEUE_MAX` / `PROXY_QUEUE_MAX_WAIT_MS` 控制，超限返回 429。已无单用户并发上限。

**排队状态可见性**：`GET /api/queue/stats`（JWT 校验，无 DB）暴露 `{ inflight, queued, maxConcurrent, maxQueue }`，前端 `QueueBanner`（仅画廊视图、有 running 任务时）每 5s 轮询并提示「当前 N 个请求排队中（预计 ~M 分钟）」，降低排队焦虑。任务卡片有「取消」按钮：中止底层 fetch，服务端收到 abort 返回 499 并释放并发槽位。

**并发经验值（2026-06-04 日志）**：6 个 Plus 账号共享 PicPilot + Codex/Responses 流量时，`/v1/images/*` 成功请求 p50≈73s、p90≈186s；同一账号同时承载 3+ 请求时成功率明显下降。默认建议 `MAX_CONCURRENT_PROXY_REQUESTS=5`、`PROXY_QUEUE_MAX=10`、`PROXY_QUEUE_MAX_WAIT_MS=240000`，即 6 个 Plus 账号允许 PicPilot 使用 5 个并发、保留 1 个上游余量。前端批量 fan-out 不写死并发数：提交前读取 `/api/queue/stats`，按当前 `maxConcurrent - inflight` 动态拆分；已有排队时降为 1。

**公平性（已知行为）**：全局队列是严格 FIFO、不区分用户。某用户（尤其 Responses/codexCli/streaming 等 fan-out 模式下一次 n=N 提交会被拆成 N 个请求）可能一次性占满 inflight + 队列，使他人排队到 `PROXY_QUEUE_MAX_WAIT_MS` 超时而 429。小团队可接受；若出现饿死，再考虑给 `acquire` 加 `userKey` 做单用户软上限（勿上 round-robin 公平队列）。

**批量上限**：`users.max_batch_images` 列仍在但已休眠——批量上限统一取**团队默认**（`defaultMaxBatchImages`，管理端 `团队设置` 配置），无 per-user 覆盖。真正在所有模式下一致生效的是**客户端 clamp**（`src/lib/paramCompatibility.ts`）；服务端 `estimateRequestedImageCount` 的 429 只是「尽力而为」兜底，且只覆盖 `/images/generations` 的 JSON 请求（edits / Responses / fan-out 会绕过）。

## 其他约定

- 面向用户的错误文案用 `getUserFacingErrorMessage`（`src/lib/userFacingText.ts`）；Toast 错误类型会经 store 做简短化处理。
- 未明确要求时不要提交 `data/auth.db` 等本地运行时文件。
- 仅在被明确要求时创建 git commit。
