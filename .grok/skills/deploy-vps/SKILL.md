---
name: deploy-vps
description: PicPilot 生产 VPS 部署与清理。发布/重新部署/回滚 Docker 栈、更新 cliproxyapi、健康检查、删除旧镜像与遗留存档时使用。触发词：部署 picpilot、deploy、发布、回滚、cleanup、清理旧镜像、删除遗留数据、verify-vps、/deploy-vps。
---

# PicPilot VPS 部署与清理

生产环境为**四个独立 Compose 项目**，源码与实盘分离。

## 目录约定

| 用途 | 路径 |
|---|---|
| 源码 | `/root/picpilot` |
| PicPilot 实盘 | `/opt/picpilot`（`.env` 含密钥，**勿提交**） |
| CLIProxyAPI 实盘 | `/opt/cliproxyapi` |
| Docker Copilot 实盘 | `/opt/dockercopilot` |
| Caddy 入口 实盘 | `/opt/caddy` |
| 配置模板（仓库） | `deploy/picpilot/`、`deploy/caddy/`、`deploy/cliproxyapi/`、`deploy/dockercopilot/` |
| 部署脚本（仓库） | `deploy/deploy.sh`、`deploy/setup-vps.sh`、`deploy/verify-vps.sh`、`deploy/cleanup-vps.sh` |
| 实盘脚本（同步后） | `/opt/picpilot/deploy.sh` 等 |

实盘配置改动后，脱敏并 `cp` 回 `deploy/` 对应子目录再提交。

## 架构速览

```
/opt/cliproxyapi    → cliproxyapi     (cliproxyapi-net)
/opt/dockercopilot  → dockercopilot   (dockercopilot-net)
/opt/caddy          → caddy           (picpilot-net + cliproxyapi-net + dockercopilot-net)
/opt/picpilot       → picpilot        (picpilot-net + cliproxyapi-net)
```

| 容器名 | Compose 项目 | 说明 |
|---|---|---|
| `caddy` | caddy | TLS 入口（80/443） |
| `cliproxyapi` | cliproxyapi | 上游出图 API |
| `dockercopilot` | dockercopilot | Docker 管理面板 |
| `picpilot` | picpilot | Go 后端 + 前端静态（单镜像单容器） |

| 域名 | Caddy 反代目标 |
|---|---|
| `image.xxww.online` | `picpilot:3001` |
| `api.xxww.online` | `cliproxyapi:8317` |
| `dc.xxww.online` | `dockercopilot:12712` |

### 命名约定

| 层级 | picpilot 栈 | cliproxyapi 栈 |
|---|---|---|
| **容器名 / Compose 服务名** | `picpilot` | `cliproxyapi` |
| **Docker 镜像名** | `picpilot-api:X.Y.Z` | `eceasy/cli-proxy-api:latest` |

- 单镜像 `picpilot-api:X.Y.Z` = Go 后端 + 前端 `dist/`（`server-go/Dockerfile` 多阶段构建，上下文为仓库根）
- 镜像标签 = `PICPILOT_VERSION`，**不带 `v` 前缀**，**禁止 `latest`**
- 各 compose 使用固定 `container_name`（简短、稳定）；脚本与 `docker logs` 统一用**容器名**
- 共享网络 `picpilot-net`（picpilot 栈创建，caddy 外部加入）；caddy 还加入 `cliproxyapi-net`、`dockercopilot-net`
- picpilot 上游地址（`.env`）：`http://cliproxyapi:8317` / `http://cliproxyapi:8317/v1`
- Docker Copilot 密钥：`/opt/dockercopilot/.env` 的 `DOCKERCOPILOT_SECRET`
- Caddy TLS 数据卷：`caddy_data`（独立 caddy 栈，非 `picpilot_caddy_data`）
- cliproxyapi 日志只读挂载：`/opt/picpilot/data/cliproxyapi-logs` → `/opt/cliproxyapi/data/logs`

### 已废弃（清理时删除）

| 旧名 | 替代 |
|---|---|
| `picpilot-auth`（镜像名） | `picpilot-api` |
| `cliproxy`（容器） | `cliproxyapi` |
| `picroilot-caddy` / `picpilot-caddy` | `caddy`（独立 `/opt/caddy`） |
| `frontend` 独立容器 | 已并入 `picpilot` 镜像 |
| `/opt/picpilot/data/cliproxy/` | `/opt/cliproxyapi/data/` |

---

## 仓库 → 实盘同步

改完 `deploy/` 模板后，同步到 VPS（agent 部署前应执行）：

```bash
ROOT=/root/picpilot

# cliproxyapi
cp "$ROOT/deploy/cliproxyapi/compose.yml" /opt/cliproxyapi/
cp "$ROOT/deploy/update-cliproxyapi.sh" /opt/cliproxyapi/
chmod +x /opt/cliproxyapi/update-cliproxyapi.sh

# caddy
cp "$ROOT/deploy/caddy/compose.yml" /opt/caddy/
cp "$ROOT/deploy/caddy/Caddyfile" /opt/caddy/

# picpilot 栈 + 运维脚本
cp "$ROOT/deploy/picpilot/compose.yml" /opt/picpilot/
cp "$ROOT/deploy/deploy.sh" /opt/picpilot/
cp "$ROOT/deploy/verify-vps.sh" /opt/picpilot/
cp "$ROOT/deploy/cleanup-vps.sh" /opt/picpilot/
chmod +x /opt/picpilot/{deploy,verify-vps,cleanup-vps}.sh
```

**勿覆盖** `/opt/picpilot/.env`、`/opt/cliproxyapi/.env`、`/opt/dockercopilot/.env`（含密钥）。

容器名变更后需重建：

```bash
docker rm -f <旧容器名> 2>/dev/null || true
cd /opt/<栈目录> && docker compose -p <项目名> up -d
```

---

## 开发后怎么部署

### 场景 1：日常改代码、不升版本

```bash
cd /root/picpilot
# 可选本地验证
npm run build && npm test && (cd server-go && go test ./...)

bash /opt/picpilot/deploy.sh          # 自动读 package.json version
# 或显式指定
bash /opt/picpilot/deploy.sh 0.1.28
```

`deploy.sh` 流程：`git pull` → 同步确保 cliproxyapi / dockercopilot 已起 → `build picpilot` → `up -d picpilot` → 确保 caddy 已起 → 内置健康检查 → `docker image prune -f`。

### 场景 2：发布新版本

1. **只改一处版本号**：`package.json` → `X.Y.Z`（SW 缓存名 `picpilot-vX.Y.Z` 构建时自动注入）
2. **发布前验证**（全绿才继续）：
   ```bash
   cd /root/picpilot
   npm run build && npm test && (cd server-go && go test ./...) && npm run lint
   ```
3. **提交并推 main**：
   ```bash
   git add package.json
   git commit -m "release: vX.Y.Z — <摘要>"
   git push origin main
   ```
4. **打 tag**（触发 GH Actions，与 VPS 部署独立）：
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z — <摘要>"
   git push origin vX.Y.Z
   ```
5. **VPS 部署**：
   ```bash
   bash /opt/picpilot/deploy.sh X.Y.Z
   ```

### 场景 3：只改 Caddyfile（无代码变更）

```bash
cp /root/picpilot/deploy/caddy/Caddyfile /opt/caddy/Caddyfile   # 若从仓库改
cd /opt/caddy && docker compose -p caddy restart caddy
bash /opt/picpilot/verify-vps.sh
```

### 场景 4：只更新 cliproxyapi（不动 picpilot）

```bash
bash /opt/cliproxyapi/update-cliproxyapi.sh
```

### 场景 4b：只更新 / 重启 Docker Copilot

```bash
cd /opt/dockercopilot
docker compose -p dockercopilot pull
docker compose -p dockercopilot up -d
```

### 场景 5：VPS 首次部署 / 重建

```bash
cd /root/picpilot
bash deploy/setup-vps.sh
# 编辑 /opt/cliproxyapi/.env、/opt/dockercopilot/.env、/opt/picpilot/.env（填真实密钥）

cd /opt/cliproxyapi && docker compose -p cliproxyapi up -d
cd /opt/dockercopilot && docker compose -p dockercopilot up -d
cd /opt/picpilot && PICPILOT_VERSION=X.Y.Z docker compose -p picpilot up -d picpilot
cd /opt/caddy && docker compose -p caddy up -d
bash /opt/picpilot/deploy.sh
```

### 场景 6：回滚

```bash
cd /opt/picpilot
PICPILOT_VERSION=<旧版本> docker compose -p picpilot up -d picpilot
bash /opt/picpilot/verify-vps.sh
```

若旧镜像已删，checkout 旧 tag 后重新 `deploy.sh <旧版本>`。

---

## 部署后验证（必做）

```bash
bash /opt/picpilot/verify-vps.sh
```

应 **15 项全绿**：

1. `cliproxyapi` / `caddy` / `picpilot` / `dockercopilot` 运行中
2. `picpilot-net` 存在；caddy、picpilot 在其上
3. caddy 在 `cliproxyapi-net`、`dockercopilot-net`
4. `dc.xxww.online` 可达
5. picpilot 日志含 `"component":"go-server"`
6. `image.xxww.online`、`api.xxww.online` HTTP 200
7. caddy → `cliproxyapi:8317` 可达
8. `cliproxyapi-logs` 符号链接存在

### 公网 URL 抽检（可选）

```bash
curl -sk https://image.xxww.online/api/health
curl -sk https://api.xxww.online/v1/models | head -c 200
curl -sk -o /dev/null -w '%{http_code}\n' https://dc.xxww.online/manager
```

---

## 怎么删除旧存档

使用 `deploy/cleanup-vps.sh`（同步后在 `/opt/picpilot/` 或直接从仓库运行）。

### 预览（推荐先跑）

```bash
bash /root/picpilot/deploy/cleanup-vps.sh --dry-run
```

### 执行清理

```bash
bash /root/picpilot/deploy/cleanup-vps.sh
# 保留 3 个 picpilot-api 版本镜像
bash /root/picpilot/deploy/cleanup-vps.sh --keep 3
```

### 脚本会删除

| 类型 | 内容 |
|---|---|
| Docker 镜像 | 全部 `picpilot-frontend:*`、`*-test`、临时镜像、`picpilot-api:latest`、遗留 `picpilot-auth:*` |
| Docker 镜像 | 旧版 `picpilot-api`（**默认保留当前 + 上一版**） |
| Docker 卷 | 悬空卷、`docker_file_caddy_data` |
| 构建缓存 | `docker builder prune -af` |
| 遗留数据 | `/opt/picpilot/data/cliproxy/`、`cliproxyapiapi/`、根目录空 `auth.db` |
| 应用备份 | `/opt/picpilot/data/picpilot/_deleted_backup_*` |
| 仓库日志 | `deploy/cliproxyapi/logs/*.log` |

### 绝不删除

- `/opt/picpilot/data/picpilot/`（`auth.db`、用户图片）
- `/opt/cliproxyapi/data/`（上游配置与 auths）
- `/opt/dockercopilot/data/`
- `caddy_data` 卷（Caddy 证书）
- 当前运行中的容器与对应镜像

### 清理后

脚本自动跑 `verify-vps.sh`；若失败则停止，检查服务。

### 发布新版本后的推荐节奏

```bash
bash /opt/picpilot/deploy.sh X.Y.Z
bash /root/picpilot/deploy/cleanup-vps.sh --keep 2
```

---

## 排查

| 现象 | 检查 |
|---|---|
| 502 + `lookup frontend` | 旧 Caddy 配置：`docker compose -p caddy restart caddy` |
| 502 + `lookup auth` / `lookup picpilot` | picpilot 未起或 Caddyfile 仍写 `auth:3001`：`docker logs picpilot`；确认反代为 `picpilot:3001` |
| 502 + `lookup cliproxy` | 已改名为 `cliproxyapi`：更新 Caddyfile 并重启 caddy |
| 404 静态文件 | 镜像不对（旧 hono/`latest`）：`docker ps` 确认 `picpilot-api:X.Y.Z` |
| 上游不可达 | `docker inspect picpilot` 是否在 `cliproxyapi-net`；`.env` 是否 `http://cliproxyapi:8317` |
| Caddyfile 改了不生效 | `docker compose -p caddy -f /opt/caddy/compose.yml restart caddy` |

**日志**：
- picpilot：`docker logs picpilot`
- caddy：`docker logs caddy`
- cliproxyapi：`docker logs cliproxyapi`；`/opt/cliproxyapi/data/logs/main.log`
- dockercopilot：`docker logs dockercopilot`

**密钥**：`/opt/picpilot/.env`、`/opt/cliproxyapi/.env`、`/opt/dockercopilot/.env` 在仓库外，勿提交。

**GH Actions ≠ VPS 生产**：tag 触发 ghcr/GH Pages，与本机 `deploy.sh` 独立。

---

## Agent 执行清单

部署或配置变更时 agent 应：

1. 读 `package.json` version
2. **同步** `deploy/` → `/opt/`（见「仓库 → 实盘同步」，不覆盖 `.env`）
3. 若容器名/compose 有变：`docker rm -f` 旧容器 → `docker compose up -d`
4. 跑 `deploy.sh`（或用户指定版本）
5. 跑 `verify-vps.sh` 确认 **15 项**通过
6. 用户要求清理时，先 `--dry-run` 再执行 `cleanup-vps.sh`
7. 实盘 compose/Caddyfile 有实质变更时，脱敏后 `cp` 回 `deploy/picpilot/`、`deploy/caddy/` 再提交