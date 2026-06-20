# 代码规范
单文件超 1000 行必须解耦

# picpilot — Agent 指南

面向在本仓库中改代码的 AI Agent 的约定与速查。

## 常用命令

依赖安装：`npm ci`。Node 24、Go 1.26。

| 任务 | 命令 |
|------|------|
| 前端开发服务器 | `npm run dev`（Vite，纯前端） |
| 本地全栈 | `npm run start:local`（装依赖 + 构建前端 + `go run` 启动 Go server，需本机装 Go）；`npm run mock:api` 起假出图 API |
| 类型检查 | `npm run typecheck`（前端 + node 配置 + SW） |
| Lint | `npm run lint` / `npm run lint:fix`（覆盖 src） |
| 全部测试 | `npm test`（vitest run，src/ 的 `*.test.ts`） |
| 单个测试文件 | `npx vitest run src/lib/imageModels.test.ts`；按用例名加 `-t '名称'` |
| Go 后端测试 | `cd server-go && go test ./...`；单个：`go test ./internal/task/ -run TestExecutor` |
| 生产构建 | `npm run build`（= typecheck + vite build + 编译 service worker） |

- 测试默认跑 node 环境；需要 DOM 的测试文件首行加 `// @vitest-environment jsdom`（参照 `src/components/workflow/WorkflowCanvas.test.tsx`）。
- CI（`.github/workflows/ci.yml`）= `typecheck + lint + npm test + go test ./...`，提交前对齐这四项。

## 架构速览

电商团队自托管的 AI 出图工作台：React 19 PWA 前端 + 自托管后端（认证 / 团队管理 / 出图代理）。生成历史与图片全存浏览器 IndexedDB（`src/lib/db.ts`），服务端 SQLite 只存用户、邀请码、事件遥测、公开画廊与异步任务。

**后端只有 Go 一套**：

- `server-go/` —— 唯一后端（chi + modernc.org/sqlite，无 CGO；compose 的 `auth` 服务由它构建，v0.1.17 起替换 TS 版，旧 `server/` TS 后端已删除）。internal 包速查：`auth`（JWT / 注册登录）、`proxy`（`/api-proxy/*` 转发）、`queue`（FIFO 并发队列）、`task`（异步任务执行器，带重试）、`chatgptreverse`（逆向 ChatGPT 账号池，reverse 模式的内置实现）、`upstream`（上游模式选择）、`upstreamcooldown`（按模型挡住对冷却中上游的重试/排队请求）、`outboundproxy`（出站代理，管理端可配）、`imageproc`（无 CGO 图像解码/缩放/WebP 编码）、`settings`（运行时团队配置，管理端改了即生效）、`admin` / `gallery` / `telemetry` / `db`。

**出图调用链**：`src/lib/api.ts` → `src/lib/openaiCompatibleImageApi.ts` 按 API 模式分发（`src/lib/openaiCompatible/` 下 Images、Responses 流式、自定义服务商等实现）→ 同源 `fetch('/api-proxy/v1/…')` 带 JWT（上游地址与 key 永不进前端）→ 后端并发队列 → 选上游：`api`（CLIProxyAPI 等 OpenAI 兼容端点，服务端注入 key）或 `reverse`（内置账号池直连 chatgpt.com）；模式按请求选择——前端按激活档案的 `upstreamMode` 发 `X-PicPilot-Upstream-Mode` 头（画廊顶栏模型选择器切换），无效或缺省时回退 env `UPSTREAM_MODE`。

**前端**：zustand 单 store（`src/store.ts`，persist 到 IndexedDB）。`App.tsx` 四个工作区：画廊（默认出图）、Agent 多轮对话、工作流画布、视频。关键模块：

- `src/lib/agentOrchestrator.ts` —— Agent 模式编排：Responses API 对话 + 工具调用（批量出图、web 搜索），产出图自动同步进画廊；平台素材槽位（Ozon / Shopify 等）定义在 `src/lib/platforms/`。
- `src/lib/workflow/engine.ts` —— 纯逻辑数据流引擎（无 React 依赖），`templates.ts` 平台模板、`runtime.ts` 桥接 store 与出图 API；画布组件 `src/components/workflow/WorkflowCanvas.tsx`（@xyflow/react）。
- `src/lib/imageModels.ts` / `chatModels.ts` —— 模型注册表；`src/lib/paramCompatibility.ts` —— 按服务商归一化参数并做批量 clamp；`src/lib/apiProfiles.ts` —— API 配置档案（`normalize*` 是恢复策略而非拒绝，勿改写成 reject 式校验）。

**部署**：生产在 VPS `/opt/picpilot`（Caddy + picpilot + cliproxyapi；`picpilot` 容器 = 单镜像 Go 后端 + 前端静态文件，`server-go/Dockerfile` 多阶段构建、上下文为仓库根），发布 / 回滚用 `deploy-vps` skill；实盘 compose 模板在 `deploy/picpilot/compose.yml`，改实盘后须同步回仓库。

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

部署在四个独立栈：`/opt/picpilot`（容器 `picpilot`）、`/opt/caddy`（`caddy`）、`/opt/cliproxyapi`（`cliproxyapi`）、`/opt/dockercopilot`（`dockercopilot`）；前端静态文件由 `picpilot` 容器内的 Go server 托管。

| 组件 | 位置 | 查看方式 |
|------|------|---------|
| picpilot 后端 + 前端静态（`server-go/`，slog JSON） | 输出到 stdout，无文件 | `docker logs picpilot`（加 `-f`/`--tail 200`/`--since 1h`） |
| CLIProxyAPI（上游出图代理） | `/opt/picpilot/data/cliproxy/logs/` | `main.log` 为主日志（含每个请求路由账号与耗时）；`error-*.log` 为单请求错误快照（请求头 + 上游响应） |
| Caddy（反代/TLS） | stdout | `docker logs picpilot-caddy-1` |

排查"出图慢"时看 `cliproxy` 的 `main.log`：每个 `/v1/images/edits` 完成行带耗时（如 `200 | 5m40s |`）和请求 id，可用 id 反查路由的 OAuth 账号 / API key 与是否回退。后端代理（`/api-proxy/*`）只设**一个全局并发上限** `MAX_CONCURRENT_PROXY_REQUESTS`，超出的请求进入 **FIFO 排队等待**（实现见 `server-go/internal/queue`，`acquire`/`release` 为抽象边界）；队列长度/等待超时由 `PROXY_QUEUE_MAX` / `PROXY_QUEUE_MAX_WAIT_MS` 控制，超限返回 429。另有单用户软上限，见下方「公平性」。

**排队状态可见性**：`GET /api/queue/stats`（JWT 校验，无 DB）暴露 `{ inflight, queued, maxConcurrent, maxQueue }`，前端 `QueueBanner`（仅画廊视图、有 running 任务时）每 5s 轮询并提示「当前 N 个请求排队中（预计 ~M 分钟）」，降低排队焦虑。任务卡片有「取消」按钮：中止底层 fetch，服务端收到 abort 返回 499 并释放并发槽位。

**并发经验值（2026-06-04 日志）**：6 个 Plus 账号共享 PicPilot + Codex/Responses 流量时，`/v1/images/*` 成功请求 p50≈73s、p90≈186s；同一账号同时承载 3+ 请求时成功率明显下降。默认建议 `MAX_CONCURRENT_PROXY_REQUESTS=5`、`PROXY_QUEUE_MAX=10`、`PROXY_QUEUE_MAX_WAIT_MS=240000`，即 6 个 Plus 账号允许 PicPilot 使用 5 个并发、保留 1 个上游余量。前端批量 fan-out 不写死并发数：提交前读取 `/api/queue/stats`，按当前 `maxConcurrent - inflight` 动态拆分；已有排队时降为 1。

**按账号数缩放（降低失败率）**：并发上限大致取「Plus 账号数 - 1」（每账号约 1 个在途、留 1 个余量），队列上限取并发的 ~2 倍。例：**11 个 Plus 账号 → `MAX_CONCURRENT_PROXY_REQUESTS=10`、`PROXY_QUEUE_MAX=20`**。提高并发能消除大部分「队满 429」，并把请求摊到更多账号（每账号约 1 并发，远低于 3+ 掉成功率的阈值）。server-go 新增 `UPSTREAM_MAX_RETRIES`（默认 2，范围 0-5）：**异步任务路径**对 5xx/429/网络错误做指数退避重试,服务端完成、客户端无感——压测在 30% 上游失败率下异步成功率由 70% 提升到 100%。同步代理路径(画廊当前走的)不做服务端重试(流式不便),其瞬时失败由前端 `galleryAutoRetryCount`(默认 1,可调高)兜底。

**公平性**：全局队列 FIFO，叠加单用户软上限 `PROXY_USER_SOFT_LIMIT`（生产 compose 默认 3，0 关闭；实现见 `server-go/internal/queue`）：某用户在途请求达到上限时，其排队请求会让位给其他用户先执行（跳位、不拒绝），缓解 fan-out 模式（Responses/codexCli/streaming 一次 n=N 提交拆成 N 个请求）占满 inflight + 队列、让他人等到 `PROXY_QUEUE_MAX_WAIT_MS` 超时 429 的问题。

**批量上限**：`users.max_batch_images` 列仍在但已休眠——批量上限统一取**团队默认**（`defaultMaxBatchImages`，管理端 `团队设置` 配置），无 per-user 覆盖。真正在所有模式下一致生效的是**客户端 clamp**（`src/lib/paramCompatibility.ts`）；服务端 `estimateRequestedImageCount` 的 429 只是「尽力而为」兜底，且只覆盖 `/images/generations` 的 JSON 请求（edits / Responses / fan-out 会绕过）。

## 其他约定

- 面向用户的错误文案用 `getUserFacingErrorMessage`（`src/lib/userFacingText.ts`）；Toast 错误类型会经 store 做简短化处理。
- 未明确要求时不要提交 `data/auth.db` 等本地运行时文件。
- 仅在被明确要求时创建 git commit。
