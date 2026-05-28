<div align="center">

# 🎨 picpilot

[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](LICENSE)
[![React](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**面向电商商品图的 AI 图片生成与编辑工作台**

提供简洁精美的 Web UI，支持 OpenAI / OpenAI 兼容接口、fal.ai 与可导入的自定义 HTTP 服务商。<br>
支持文本生图、参考图与遮罩编辑，数据纯本地化存储，带来流畅的历史记录与参数管理体验。

</div>

---

## 📸 界面预览

<details>
<summary><b>点击展开截图展示</b></summary>
<br>

<div align="center">
  <b>桌面端主界面</b><br>
  <img src="docs/images/example_pc_1.jpg" alt="桌面端主界面" />
</div>

<br>

<div align="center">
  <b>任务详情与实际参数</b><br>
  <img src="docs/images/example_pc_2.jpg" alt="任务详情与实际参数" />
</div>

<br>

<div align="center">
  <b>桌面端批量选择</b><br>
  <img src="docs/images/example_pc_3.jpg" alt="桌面端批量选择" />
</div>

<br>

<div align="center">
  <b>桌面端 Agent 模式</b><br>
  <img src="docs/images/example_pc_4.jpg" alt="桌面端 Agent 模式" />
</div>

<br>

<div align="center">
  <b>移动端主界面</b><br>
  <img src="docs/images/example_mb_1.jpg" alt="移动端主界面" width="420" />
</div>

<br>

<div align="center">
  <b>移动端侧滑多选</b><br>
  <img src="docs/images/example_mb_2.jpg" alt="移动端侧滑多选" width="420" />
</div>

</details>

---

## ✨ 核心特性

### 🎨 强大的图像生成与编辑
- **参考图与遮罩**：支持上传最多 16 张参考图（支持剪贴板和拖拽）。内置可视化遮罩编辑器，自动预处理以符合官方分辨率限制。
- **批量与迭代**：支持单次多图生成；一键将满意结果转为参考图，无缝开启下一轮修改。
- **流式生成预览**：`Images API` 与 `Responses API` 模式均支持流式接收中间步骤图像，缓解连接超时问题。

### 🤖 Agent 多轮对话模式
- **多轮对话与上下文记忆**：基于 Responses API 的对话式生成，Agent 会理解上下文并按需调用图像工具；支持 `@` 引用参考图或前面轮次生成的图片，并自动识别上下文中的图片。
- **并发批量生成**：内置 `generate_image_batch` 工具，让 Agent 在一次轮次中并发生成多张关联图像，并通过 `continue_generation` 自动追加新一轮以处理依赖关系。
- **分支与重新生成**：编辑某轮消息重新发送或重新生成某轮消息会产生可切换的分支，引用解析严格限定在当前分支路径内，避免误用其他分支的图片。
- **画廊同步与隔离删除**：Agent 生成的图片会同步到画廊；删除对话默认保留画廊记录，删除画廊任务时也会自动清理对话中残留的图片引用。
- **可选 Web 搜索**：可开启 `web_search` 工具，Agent 会在需要时搜索网络信息并附带引用链接。

### ⚙️ 精细化参数追踪
- **智能尺寸控制**：提供 1K/2K/4K 快速预设，自定义宽高时会自动规整至模型安全范围（16 的倍数、总像素校验等）。
- **实际参数对比**：自动提取 API 响应中真实生效的尺寸、质量、耗时以及**模型改写后的提示词**，与你的请求参数高亮对比。支持定制化的参数列表横向平滑滚动体验。

### 📁 高效历史管理 (纯本地)
- **瀑布流与画廊**：历史任务自动保存，支持按状态过滤、全屏大图预览与快捷下载。
- **快捷批量操作**：桌面端支持鼠标拖拽框选、Ctrl/⌘ 连选，移动端支持顺滑侧滑多选；轻松实现批量收藏与清理。
- **优化的图片查看与下载**：大图预览支持左右滑动切换、移动端长按弹出操作菜单，支持快捷下载与批量下载。
- **极致性能与隐私**：所有记录与图片均存放在浏览器 IndexedDB 中（采用 SHA-256 去重压缩），不经过任何第三方服务器。支持一键打包导出 ZIP 备份。

### 🔌 多配置与服务商增强
- **多配置管理**：支持创建并保存多个 API 配置（包含服务商、API Key、模型等），按需快速切换；支持一键复制当前配置到列表底部，并通过拖拽对配置列表与服务商列表进行自定义排序。
- **多服务商接入**：内置 OpenAI 兼容接口（含 `Images API` 和 `Responses API`）、fal.ai（支持队列），并支持通过 JSON 导入自定义 HTTP 服务商配置（兼容同步/异步任务）。
- **API 代理**：OpenAI 兼容接口与 fal.ai 均可配置自定义代理。其中 OpenAI 兼容接口可开启同源 `/api-proxy/` 代理，交由 Docker 或本地开发环境转发至真实 API，绕开浏览器 CORS 限制。
- **Codex CLI 兼容模式**：对上游为 Codex CLI 的 API，开启后应用 Codex CLI 实际支持的参数，并将多图生成拆分为并发单图。
- **提示词防改写**：Responses API 会始终在请求文本前加入强制指令防止提示词被改写；开启 Codex CLI 模式后，Images API 也会获得同等保护。
- **智能诊断提示**：当检测到接口异常改写行为或缺少常规参数时，自动提示开启相应的兼容模式。
- **习惯配置**：支持设置提交后清空输入、重启后保留历史输入、临时复用历史任务 API 配置等。

---

## 🚀 部署与使用

支持多种部署与开发方式。无论使用哪种方式，你都可以预设默认的 API 节点。

<details>
<summary><strong>☁️ 方式一：Cloudflare Workers 部署</strong></summary>

项目已内置 Wrangler 配置，可将 Vite 构建产物作为 Cloudflare Workers 静态资源部署。

**1. 登录 Cloudflare**

```bash
bunx wrangler login
```

**2. 部署到 Workers**

```bash
bun run deploy:cf
```

部署脚本会先执行 `bun run build`，再通过 `wrangler deploy` 上传 `dist/` 目录。

**配置默认 API URL**：Cloudflare Workers 的环境变量不会自动改写已经构建好的静态文件。若需预设默认 API 地址，请在构建前设置 `VITE_DEFAULT_API_URL` 后再部署。

```bash
VITE_DEFAULT_API_URL=https://api.openai.com/v1 bun run deploy:cf
```

PowerShell 示例：

```powershell
$env:VITE_DEFAULT_API_URL="https://api.openai.com/v1"; bun run deploy:cf
```

**导入自定义服务商配置**：`VITE_DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

</details>

<details>
<summary><strong>🐳 方式二：Docker 部署</strong></summary>

官方镜像已发布至 GitHub Container Registry。Docker 部署支持在运行时注入默认配置。

**环境变量说明：**

- `DEFAULT_API_URL`：设置页面上默认显示的 API 地址（如 `https://api.openai.com/v1`）。也支持填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL 来导入自定义服务商配置（详见下方说明）。
- `API_PROXY_URL` / `TEAM_API_BASE_URL`：配置团队默认上游 API 基础地址（仅开启代理时有效）。代理不会自动补 `/v1`，OpenAI 兼容接口通常必须填写到版本前缀，如 `https://api.openai.com/v1`。
- `API_PROXY_API_KEY` / `TEAM_API_KEY`：配置团队共享 API Key。开启代理后，默认配置可不在前端填写 Key，由服务端注入该密钥。
- `DEFAULT_HOURLY_IMAGE_QUOTA`：新用户默认团队服务小时额度，按「过去 1 小时成功输出图片张数」计算，默认 `100`。管理员可在管理面板为每个用户单独调整。
- `ENABLE_API_PROXY`：设为 `true` 开启容器内置同源代理。前端请求 `/api-proxy/{接口相对路径}` 时会先校验当前登录用户，再由服务端转发到团队上游 API；用户仍可在设置中手动关闭代理并填写自己的 API URL / API Key。
- `LOCK_API_PROXY`：设为 `true` 时，在 `ENABLE_API_PROXY=true` 的前提下将前端 **API 代理** 开关强制锁定为开启，用户无法关闭。
- `HOST` / `PORT`：指定容器内 Caddy 监听的地址和端口（默认 `0.0.0.0:80`）。

> 💡 **团队默认配置**：50 人小团队共用一个上游时，推荐设置 `ENABLE_API_PROXY=true`、`API_PROXY_URL`、`API_PROXY_API_KEY`，并让默认配置留空 API URL / API Key。需要自定义上游的成员可在设置中关闭 **API 代理**，再填写自己的 URL 和 Key。

> 💡 **导入自定义服务商配置**：`DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

> 💡 **隐藏真实 API 地址**：如果不希望用户在前端看到真实的 API 上游地址，可以配合 `ENABLE_API_PROXY=true` 和 `LOCK_API_PROXY=true` 强制所有请求走服务器代理，再将 `API_PROXY_URL` 与 `API_PROXY_API_KEY` 设为真实上游配置。根据使用的服务商类型，`DEFAULT_API_URL` 的填法不同：
>
> - **OpenAI 兼容接口**：将 `DEFAULT_API_URL` 留空或填写一个占位地址（如 `https://proxy`）。
> - **自定义服务商配置**：将 `DEFAULT_API_URL` 设为配置 URL（`.json` 或带 `settings` 参数的分享 URL），配置 JSON 中 profile 的 `baseUrl` 留空或填占位地址，并设置 `apiProxy:true`。
>
> 这样前端设置页只会显示空值或占位地址，真实 API 地址仅存在于服务器侧的 `API_PROXY_URL`，不会暴露给用户。
>
> 自定义服务商开启代理仅支持同步返回图片的配置；包含 `taskIdPath` 或 `poll` 的异步任务自定义服务商暂不支持 API 代理。

> 💡 **兼容迁移**：旧版本中的 `API_URL` 已拆分为 `DEFAULT_API_URL` 和 `API_PROXY_URL`。容器启动时会自动将遗留的 `API_URL` 作为两个新变量的兜底值，实现无缝兼容。建议更新配置文件，逐步迁移至新变量。

**1. Docker Compose 示例（推荐团队部署）**

在项目根目录创建 `.env`：

```env
PORT=8080
ENABLE_API_PROXY=true
API_PROXY_URL=https://api.openai.com/v1
API_PROXY_API_KEY=sk-xxxx
DEFAULT_HOURLY_IMAGE_QUOTA=100
JWT_SECRET=请替换为长随机字符串
ADMIN_USERS=admin:请替换为强密码
```

然后启动内置的前端 + 鉴权服务：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

单容器 Docker CLI 更适合纯静态前端部署；团队默认 Key、登录鉴权、公开画廊和服务端代理需要同时运行 `frontend` 与 `auth` 两个服务，建议使用上面的 Compose 方式。

</details>

<details>
<summary><strong>💻 方式三：本地开发与静态构建</strong></summary>

**1. 环境准备与启动**

本项目完全使用 Bun 驱动。你可以在项目根目录新建 `.env.local` 文件配置默认 API URL（如 `VITE_DEFAULT_API_URL=https://api.openai.com/v1`）。前端热更新开发可运行：

**导入自定义服务商配置**：`VITE_DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

```bash
bun install
bun run dev
```

如果需要一键执行“安装依赖 -> 构建 -> 预览静态产物”，可运行：

```bash
bun run start:local
```

`start:local` 会构建前端产物，然后启动单个 Hono 应用服务：Hono 同时负责 `/api/*` 接口和 `dist/` 静态文件，因此访问 `http://localhost:3001` 会显示登录界面。默认本地管理员为 `admin` / `admin`；如需自定义，可在启动前设置 `ADMIN_USERS="用户名:密码"` 和 `JWT_SECRET="长随机字符串"`。

**2. 本地开发跨域代理 (可选)**

如果在本地开发时遇到浏览器的 CORS 限制，可开启本地代理转发：

```bash
cp dev-proxy.config.example.json dev-proxy.config.json
```

修改 `dev-proxy.config.json`，将 `target` 设置为真实的完整 API 基础地址。代理不会自动补 `/v1`，OpenAI 兼容接口通常必须填写到版本前缀，如 `https://api.example.com/v1`。重启开发服务器后，在页面设置中开启 **API 代理** 即可（请求将被转发如 `http://localhost:5173/api-proxy/... -> target/...`）。此功能仅在 `bun run dev` 阶段生效，不会影响打包产物。

**3. 本地故障模拟 API (可选)**

如果需要复现图片 URL 跨域、接口返回结构异常、原始响应查看等问题，可启动内置模拟服务：

```powershell
bun run mock:api
```

使用方式见 [本地故障模拟 API](docs/mock-image-api.md)。

**4. 构建静态产物**

```bash
bun run build
```

构建会先执行前端、Node 配置脚本和 Service Worker 的 TypeScript 检查；如需连同服务端一起检查，可运行 `bun run typecheck:all`。构建输出的文件位于 `dist/` 目录下，可将其部署至任何静态文件服务器（如 Caddy、GitHub Pages、Netlify 等）。

</details>

---

## 🛠️ URL 传参快速填充

应用支持通过 URL 查询参数快速填入配置，非常适合创建书签或集成分享。根据你的服务商类型，选择对应的方式：

**方式一：标准 OpenAI 兼容服务商**
直接使用简短的查询参数配置：
- `?apiUrl=https://你的代理地址.com`
- `?apiKey=sk-xxxx`
- `?apiMode=images` 或 `?apiMode=responses`（未传时默认为 `images`）
- `?model=gpt-image-2`（未传时按 `apiMode` 使用默认模型）
- `?codexCli=true`（开启 Codex CLI 兼容模式）

例如，集成到 New API 的聊天系统：

```text
https://your-deployed-url?apiUrl={address}&apiKey={key}&model={model}
```

**方式二：自定义格式服务商**
如果需要导入自定义格式的 API 配置，请使用 `settings` 参数并传入 URL 编码后的完整 JSON：
- `?settings={URL编码后的JSON}`（只读取 `customProviders` 和 `profiles` 列表）

> 推荐先在项目内完成配置生成与导入：
>
> **设置 - API 配置 - 服务商类型 - 创建自定义服务商 - AI 一键生成与导入**
>
> 完成后可在 **API 配置 - 当前配置** 使用右侧快捷按钮：
>
> - **链接按钮**：复制可导入配置的 URL。复制时可选择不包含 API Key，并使用 `{address}`、`{key}`、`{model}` 等变量，便于在 New API 等平台中集成分享。
> - **复制按钮**：将当前配置复制一份到配置列表底部，新配置名称会追加“（复制）”。

JSON 结构示例：

```json
{
  "customProviders": [
    {
      "id": "custom-example-task",
      "name": "示例异步任务服务商",
      "submit": {
        "path": "images/generations",
        "method": "POST",
        "contentType": "json",
        "body": {
          "model": "$profile.model",
          "prompt": "$prompt",
          "size": "$params.size",
          "quality": "$params.quality",
          "output_format": "$params.output_format",
          "output_compression": "$params.output_compression",
          "n": "$params.n",
          "image_urls": "$inputImages.dataUrls"
        },
        "taskIdPath": "data.0.task_id"
      },
      "poll": {
        "path": "tasks/{task_id}",
        "method": "GET",
        "intervalSeconds": 5,
        "statusPath": "data.status",
        "successValues": ["completed"],
        "failureValues": ["failed", "cancelled"],
        "errorPath": "data.error.message",
        "result": {
          "imageUrlPaths": ["data.result.images.*.url.*"],
          "b64JsonPaths": []
        }
      }
    }
  ],
  "profiles": [
    {
      "name": "示例异步任务服务商",
      "provider": "custom-example-task",
      "baseUrl": "https://api.example.com/v1",
      "model": "example-image-model",
      "apiMode": "images"
    }
  ]
}
```

第三方服务商可以参考 [自定义服务商 LLM 提示词](docs/custom-provider-llm-prompt.md)，让 LLM 根据自己的 API 文档生成可导入的完整配置。导入后只需要在设置里补充 API Key。

---

## 💻 技术栈

<div align="center">
  <br>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS_3-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS 3" /></a>
  <a href="https://zustand.docs.pmnd.rs/"><img src="https://img.shields.io/badge/Zustand-764ABC?style=for-the-badge&logo=react&logoColor=white" alt="Zustand" /></a>
  <br>
  <br>
</div>

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。
