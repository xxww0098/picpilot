# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## 常用命令

```bash
# 前端（CI 与此一致：typecheck → lint → test）
npm run typecheck           # 前端 tsc -b + node 配置 + SW
npm run lint                # eslint src
npm test                    # vitest run（src/ 的 *.test.ts）
npx vitest run src/lib/imageModels.test.ts   # 跑单个测试文件
npx vitest run -t "用例名"                    # 按用例名过滤
npm run build               # typecheck + vite build + 编译 Service Worker

# Go 后端（唯一后端）
cd server-go && go test ./...
cd server-go && go test ./internal/proxy/ -run TestName   # 单个测试

# 本地运行
npm run dev                 # 仅前端热更新（可配 dev-proxy.config.json 或 LOCAL_AUTH_PROXY_URL 转发 /api）
npm run start:local         # 构建前端 + go run 启动 Go server（/api + 静态文件），admin/admin，http://localhost:3001
npm run mock:api            # 故障模拟图片 API（见 docs/mock-image-api.md）
```

注意：组件测试文件需顶部 `// @vitest-environment jsdom` 注释（默认环境是 node）。

发布部署用 `/deploy-vps` skill（版本号、git tag、deploy.sh、健康检查、回滚都有约定，勿手搓）。

## 架构

两个可执行部分：

- **`src/` 前端**（React 19 + Zustand + Tailwind，Vite 构建，PWA）：用户的任务记录与图片**只存浏览器 IndexedDB**（`src/lib/db.ts`，SHA-256 去重），不上传服务器；`src/store.ts` 是单一 Zustand store。
- **`server-go/` 后端**（Go + chi + modernc.org/sqlite，无 CGO，docker compose 里的 `auth` 服务）：认证 / 管理后台 / 共享画廊 / 上游代理，本地与生产都是它（本地经 `STATIC_DIR` 托管 dist/）。旧 TS 后端 `server/` 已删除。

### 请求链路（核心约束）

前端**永远拿不到上游地址与 API Key**。所有出图请求走同源 `/api-proxy/*`，由后端按 JWT 鉴权后转发到 env 决定的上游：`UPSTREAM_MODE=api` 时走 `API_PROXY_URL`（通常是 CLIProxyAPI）；`UPSTREAM_MODE=reverse` + `REVERSE_PROXY_URL=internal` 时走 Go 内置 ChatGPT 逆向（`internal/chatgptreverse`，OAuth 账号存 SQLite，管理面板导入）。代理有全局 FIFO 并发队列（`internal/queue`，参数与调优经验见 AGENTS.md）。

### server-go/internal 关键包

`proxy`（/api-proxy 转发 + 并发槽位）、`upstream`（按 UPSTREAM_MODE 选上游）、`chatgptreverse`（内置 ChatGPT 逆向 + 账号池）、`task`（异步任务执行器，带 UPSTREAM_MAX_RETRIES 指数退避重试）、`queue`（FIFO 信号量）、`auth`/`admin`/`gallery`/`settings`（团队功能，settings 为管理端运行时配置、改了即生效无需重启）。

### 前端关键模块

- **API 分层**：`src/lib/api.ts` 是出图入口 → `openaiCompatibleImageApi.ts` 按 apiMode 分发到 Images API / Responses API / 自定义 HTTP 服务商；批量上限 clamp 在 `paramCompatibility.ts`（客户端 clamp 是唯一全模式生效的限制）。
- **Agent 模式**：`src/lib/agentOrchestrator.ts`（多轮对话、工具调用、分支树 `agentConversationTree.ts`、图片引用 `agentImageReferences.ts`）。
- **工作流画布**：`src/lib/workflow/engine.ts` 是纯逻辑 DAG 执行器（生成回调注入、可单测），`templates.ts` 是按平台（Ozon 等）拆分的上架模板；UI 在 `src/components/workflow/`（@xyflow/react）。
- **四个视图**在 App.tsx 懒加载切换：gallery（默认）/ agent / workflow / video。懒加载 chunk 有 ErrorBoundary 兜底刷新，别移除。
- **图像模型选择**：`src/lib/imageModels.ts` + 各模型能力差异 `imageProviderCapabilities.ts`。
