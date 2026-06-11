# VPS 部署指南

picpilot 在 VPS 上通过 Docker Compose 部署，包含 4 个服务：Caddy（反向代理 / TLS）、CLIProxyAPI（上游 API 代理）、DockerCopilot（容器管理）、PicPilot Auth（单镜像：Go 后端 + 前端静态文件）。

## 目录结构

```
/opt/picpilot/
├── compose.yml
├── Caddyfile
├── .env
└── data/
    ├── picpilot/       ← SQLite 数据库、头像、公开图（bind mount）
    ├── cliproxy/       ← CLIProxyAPI 配置、授权文件、日志
    └── dockercopilot/  ← DockerCopilot 配置
```

所有持久化数据都在 `data/` 目录下，备份只需：

```bash
tar czf picpilot-backup.tar.gz /opt/picpilot/data/
```

## 环境变量 (.env)

```env
ADMIN_USERS=admin:your-strong-password
JWT_SECRET=<openssl rand -hex 32 生成>
UPSTREAM_MODE=api
API_PROXY_API_KEY=your-api-key
CLIPROXY_API_URL=http://cliproxy:8317
CLIPROXY_MGMT_KEY=your-management-key
REVERSE_PROXY_URL=internal
MAX_CONCURRENT_PROXY_REQUESTS=5
PROXY_QUEUE_MAX=10
PROXY_QUEUE_MAX_WAIT_MS=240000
```

| 变量 | 说明 | 必填 |
|------|------|------|
| `ADMIN_USERS` | 管理员账号，格式 `用户名:密码` | 是 |
| `JWT_SECRET` | JWT 签名密钥，至少 32 字符 | 是 |
| `UPSTREAM_MODE` | 上游模式：`api` 使用 CLIProxy/API，`reverse` 使用 Go 内置 ChatGPT 逆向 | 否 |
| `API_PROXY_API_KEY` | API 模式 CLIProxyAPI 的 API Key | `api` 模式必填 |
| `CLIPROXY_API_URL` | CLIProxyAPI 地址（默认 `http://cliproxy:8317`） | 否 |
| `CLIPROXY_MGMT_KEY` | CLIProxyAPI 管理密钥（用于查询凭证状态） | 否 |
| `REVERSE_PROXY_URL` | reverse 模式地址；内置实现填 `internal` | `reverse` 模式必填 |
| `OUTBOUND_PROXY_TYPE` | 服务端出站代理默认类型：`env` / `none` / `http` / `https` / `socks5` / `socks5h`，可在管理端运行时覆盖 | 否 |
| `OUTBOUND_PROXY_URL` | 出站代理默认地址，格式 `host:port` 或完整代理 URL | 否 |
| `MAX_CONCURRENT_PROXY_REQUESTS` | 全局并发上限（默认 5） | 否 |
| `PROXY_QUEUE_MAX` | 等待队列长度上限（默认 10），已满则立即 429 | 否 |
| `PROXY_QUEUE_MAX_WAIT_MS` | 排队最长等待毫秒（默认 240000，上限 240000），超时返回 429 | 否 |

reverse 模式默认使用 Go 内置实现，不需要 `chatgpt2api` 容器：

管理员可在「管理面板 → 逆向账号」导入或删除 ChatGPT/Codex OAuth JSON；账号只存入 PicPilot SQLite 数据库，不需要给 auth 容器挂载账号目录。

```bash
cd /opt/picpilot
docker compose -f compose.yml up -d auth
```

## 并发控制

以**一个全局并发队列**为主，超出的请求进入 **FIFO 队列排队等待**；前一个请求完成、腾出槽位后按顺序放行。另有单用户软上限用于公平调度，内置 reverse 还叠加单账号并发保护。

| 层级 | 参数 | 默认值 | 作用 |
|------|------|--------|------|
| 全局并发 | `MAX_CONCURRENT_PROXY_REQUESTS` | 5 | 同时最多 5 个生图请求进入上游 |
| 排队上限 | `PROXY_QUEUE_MAX` | 10 | 最多 10 个请求排队，超出立即 429 |
| 排队超时 | `PROXY_QUEUE_MAX_WAIT_MS` | 240000 | 排队等待超过 240s 返回 429 |
| 单用户软上限 | `PROXY_USER_SOFT_LIMIT` | 3 | 某个用户已占用过多在途请求时，优先放行后方其他用户 |
| reverse 单账号并发 | `CHATGPT_REVERSE_ACCOUNT_CONCURRENCY` | 1 | 内置 reverse 每个 ChatGPT 账号最多同时跑多少请求 |
| 单次批量 | `DEFAULT_MAX_BATCH_IMAGES` | 10 | 一次请求最多 10 张图（前端 UI 上限同为 10） |

- 全局并发应根据 CLIProxyAPI 的上游凭证数量和账号类型调整。Plus 账号跑长图像任务时按「约 1 个账号承载 1 个长请求」估算；当前 6 个 Plus 账号允许 PicPilot 使用 5 个并发，保留 1 个上游余量。
- 内置 reverse 的单 IP 账号池建议保持 `CHATGPT_REVERSE_ACCOUNT_CONCURRENCY=1`；只有确认同账号多路请求稳定时再从管理端调到 `2-5`。
- 单个批量任务不会固定拆分并发数：前端发起任务前读取 `/api/queue/stats`，按当前 `maxConcurrent - inflight` 动态决定 fan-out；已有排队时降为 1，避免单个批量任务继续扩大排队。
- 排队超时在服务端被钳制在 240s 内（`server-go` 的 `clampInt`），避免请求在静默排队期挂太久。
- 客户端 API Profile 的超时（`timeout`）应设得**大于「排队超时 + 单次生成耗时」**，否则请求会在客户端侧先超时。出图慢时单次可达数分钟，建议 profile 超时设到 5–10 分钟。
- 队列为单进程内存态，适用于当前单 `auth` 容器部署；若横向扩多副本需改用共享协调层（如 Redis），详见代码 `server-go/internal/queue` 的抽象边界。

## compose.yml

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    extra_hosts: ["host.docker.internal:host-gateway"]

  cliproxy:
    image: eceasy/cli-proxy-api:latest
    restart: unless-stopped
    pull_policy: always
    environment:
      DEPLOY: docker
    volumes:
      - ./data/cliproxy/config.yaml:/CLIProxyAPI/config.yaml
      - ./data/cliproxy/auths:/root/.cli-proxy-api
      - ./data/cliproxy/logs:/CLIProxyAPI/logs

  dockercopilot:
    image: 0nlylty/dockercopilot:latest
    restart: unless-stopped
    privileged: true
    environment:
      TZ: Asia/Tokyo
      DOCKER_HOST: unix:///var/run/docker.sock
      secretKey: <随机生成>
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data/dockercopilot:/data

  # 单镜像 = Go 后端 + 前端静态文件（构建上下文必须是仓库根）
  auth:
    build:
      context: /root/picpilot
      dockerfile: server-go/Dockerfile
    restart: unless-stopped
    environment:
      - ADMIN_USERS=${ADMIN_USERS}
      - JWT_SECRET=${JWT_SECRET}
      - UPSTREAM_MODE=${UPSTREAM_MODE:-api}
      - API_PROXY_URL=${API_PROXY_URL:-http://cliproxy:8317/v1}
      - API_PROXY_API_KEY=${API_PROXY_API_KEY}
      - REVERSE_PROXY_URL=${REVERSE_PROXY_URL:-internal}
      - REVERSE_PROXY_API_KEY=${REVERSE_PROXY_API_KEY}
      - CHATGPT2API_AUTH_KEY=${CHATGPT2API_AUTH_KEY}
      - CHATGPT_REVERSE_BASE_URL=${CHATGPT_REVERSE_BASE_URL:-https://chatgpt.com}
      - CLIPROXY_API_URL=${CLIPROXY_API_URL:-http://cliproxy:8317}
      - CLIPROXY_MGMT_KEY=${CLIPROXY_MGMT_KEY}
      - MAX_CONCURRENT_PROXY_REQUESTS=${MAX_CONCURRENT_PROXY_REQUESTS:-5}
      - PROXY_QUEUE_MAX=${PROXY_QUEUE_MAX:-10}
      - PROXY_QUEUE_MAX_WAIT_MS=${PROXY_QUEUE_MAX_WAIT_MS:-240000}
      - DATA_DIR=/data
      - DB_PATH=/data/auth.db
    volumes:
      - ./data/picpilot:/data

volumes:
  caddy_data:
```

## Caddyfile

```caddyfile
{
  email your-email@example.com
}

# auth（Go server）同时托管前端静态文件与 /api、/api-proxy；
# 长超时用于出图流式响应，request_body 上限保护大图上传。
image.xxww.online {
  encode zstd gzip

  request_body {
    max_size 600MB
  }

  reverse_proxy auth:3001 {
    header_up X-Real-IP {remote_host}
    transport http {
      dial_timeout 60s
      response_header_timeout 600s
      read_timeout 600s
      write_timeout 600s
    }
  }
}

api.xxww.online {
  reverse_proxy cliproxy:8317
}

dc.xxww.online {
  reverse_proxy dockercopilot:12712
}
```

按实际域名修改。Caddy 会自动申请 HTTPS 证书。

## 首次部署

```bash
# 1. 创建目录
mkdir -p /opt/picpilot/data/{picpilot,cliproxy,dockercopilot}

# 2. 创建上述 compose.yml、Caddyfile、.env

# 3. 准备 CLIProxyAPI 配置
#    将 config.yaml 放到 data/cliproxy/config.yaml

# 4. 启动
cd /opt/picpilot
docker compose up -d --build

# 5. 验证
docker compose ps
curl -X POST https://image.xxww.online/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'
```

## 日常操作

```bash
# 更新代码后重新构建
cd /opt/picpilot
docker compose build && docker compose up -d

# 查看日志
docker compose logs -f auth

# 备份数据
tar czf backup-$(date +%Y%m%d).tar.gz /opt/picpilot/data/
```
