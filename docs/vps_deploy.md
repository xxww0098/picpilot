# VPS 部署指南

picpilot 在 VPS 上通过 Docker Compose 部署，包含 5 个服务：Caddy（反向代理）、CLIProxyAPI（上游 API 代理）、DockerCopilot（容器管理）、PicPilot Frontend、PicPilot Auth。

## 目录结构

```
/opt/docker_file/
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
tar czf picpilot-backup.tar.gz /opt/docker_file/data/
```

## 环境变量 (.env)

```env
ADMIN_USERS=admin:your-strong-password
JWT_SECRET=<openssl rand -hex 32 生成>
API_PROXY_API_KEY=your-api-key
CLIPROXY_API_URL=http://cliproxy:8317
CLIPROXY_MGMT_KEY=your-management-key
MAX_CONCURRENT_PROXY_REQUESTS=5
MAX_CONCURRENT_PER_USER=2
```

| 变量 | 说明 | 必填 |
|------|------|------|
| `ADMIN_USERS` | 管理员账号，格式 `用户名:密码` | 是 |
| `JWT_SECRET` | JWT 签名密钥，至少 32 字符 | 是 |
| `API_PROXY_API_KEY` | CLIProxyAPI 的 API Key | 是 |
| `CLIPROXY_API_URL` | CLIProxyAPI 地址（默认 `http://cliproxy:8317`） | 否 |
| `CLIPROXY_MGMT_KEY` | CLIProxyAPI 管理密钥（用于查询凭证状态） | 否 |
| `MAX_CONCURRENT_PROXY_REQUESTS` | 团队全局并发上限（默认 5） | 否 |
| `MAX_CONCURRENT_PER_USER` | 单用户并发上限（默认 2） | 否 |

## 并发控制

系统采用三层并发限制：

| 层级 | 参数 | 默认值 | 作用 |
|------|------|--------|------|
| 团队并发 | `MAX_CONCURRENT_PROXY_REQUESTS` | 5 | 全局同时最多 5 个生图请求 |
| 用户并发 | `MAX_CONCURRENT_PER_USER` | 2 | 单用户同时最多 2 个请求 |
| 单次批量 | `DEFAULT_MAX_BATCH_IMAGES` | 4 | 一次请求最多 4 张图 |

并发上限应根据 CLIProxyAPI 的上游凭证数量调整。每增加一个 API Key，可将 `MAX_CONCURRENT_PROXY_REQUESTS` 增加 5。

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

  frontend:
    build:
      context: /root/picpilot
      dockerfile: deploy/Dockerfile
    restart: unless-stopped

  auth:
    build:
      context: /root/picpilot/server
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      - ADMIN_USERS=${ADMIN_USERS}
      - JWT_SECRET=${JWT_SECRET}
      - API_PROXY_URL=${API_PROXY_URL:-http://cliproxy:8317/v1}
      - API_PROXY_API_KEY=${API_PROXY_API_KEY}
      - CLIPROXY_API_URL=${CLIPROXY_API_URL:-http://cliproxy:8317}
      - CLIPROXY_MGMT_KEY=${CLIPROXY_MGMT_KEY}
      - MAX_CONCURRENT_PROXY_REQUESTS=${MAX_CONCURRENT_PROXY_REQUESTS:-5}
      - MAX_CONCURRENT_PER_USER=${MAX_CONCURRENT_PER_USER:-2}
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

image.xxww.online {
  reverse_proxy frontend:80
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
mkdir -p /opt/docker_file/data/{picpilot,cliproxy,dockercopilot}

# 2. 创建上述 compose.yml、Caddyfile、.env

# 3. 准备 CLIProxyAPI 配置
#    将 config.yaml 放到 data/cliproxy/config.yaml

# 4. 启动
cd /opt/docker_file
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
cd /opt/docker_file
docker compose build && docker compose up -d

# 查看日志
docker compose logs -f auth

# 备份数据
tar czf backup-$(date +%Y%m%d).tar.gz /opt/docker_file/data/
```
