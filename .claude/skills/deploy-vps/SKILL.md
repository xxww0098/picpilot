---
name: deploy-vps
description: 在 VPS 上发布并部署 picpilot 的生产 Docker 环境。当需要发布新版本(release a new version)、重新部署(redeploy)最新代码、回滚(rollback),或排查 VPS 上 picpilot 的 Docker 容器/构建/部署问题时使用。涵盖版本号变更、构建验证、git tag、deploy.sh、部署后健康检查与回滚。
---

# picpilot VPS Docker 部署

本 skill 固化在生产 VPS 上发布并部署 picpilot 的完整流程(已实测验证)。

## 拓扑与约定(生产 VPS)

- **源码**:`/root/picpilot`(本仓库)。**部署目录**:`/opt/docker_file`(`compose.yml`/`.env`/`Caddyfile`/`data/`/`deploy.sh`,均在仓库之外、含真实密钥,**勿提交**)。
- **实盘配置版本化备份**(仓库内,VPS 重建/丢失时可恢复):
  - `deploy/deploy.sh` ← `/opt/docker_file/deploy.sh`(忠实备份)
  - `deploy/vps/compose.yml` ← `/opt/docker_file/compose.yml`(**已脱敏**:dockercopilot `secretKey` 改为 `${DOCKERCOPILOT_SECRET}`)
  - `deploy/vps/Caddyfile` ← `/opt/docker_file/Caddyfile`(host 级反代:域名 → 各服务)
  - `deploy/vps/.env.example`:实盘 `/opt/docker_file/.env` 所需变量清单(占位值,无真密钥)
  - **改动实盘配置后,`cp` 回对应仓库文件并提交**(compose 记得把 `secretKey` 重新脱敏成 `${DOCKERCOPILOT_SECRET}`),保持一致。
  - 注:仓库根的 `deploy/docker-compose.yml` 与 `deploy/Caddyfile` 是**另一套自包含模板**(前端镜像内 SPA + 反代),与实盘 host 全栈用途不同,勿混淆。
- **镜像本机构建**(非拉取 ghcr):`/opt/docker_file/compose.yml` 用 `build:` 从源码构建 `picpilot-frontend`(`deploy/Dockerfile`)与 `picpilot-auth`(`server/Dockerfile`);镜像标签 = `PICPILOT_VERSION`,**不带 `v` 前缀**(如 `0.1.7`,与历史 `0.1.6` 一致)。
- **服务**(compose):`caddy`(TLS 反代)、`cliproxy`(上游出图代理)、`dockercopilot`、`frontend`、`auth`。容器名形如 `docker_file-auth-1`。
- **域名**(Caddyfile):`image.xxww.online`→frontend:80、`api.xxww.online`→cliproxy:8317、`dc.xxww.online`→dockercopilot。
- **版本号两处必须同步**:`package.json` 的 `version` 与 `src/sw.ts` 的 `CACHE_NAME = 'picpilot-vX.Y.Z'`(改 SW 缓存名才会让老客户端在下次访问时刷新缓存)。About 页的 `__APP_VERSION__` 由 vite 从 `package.json` 自动注入,**无需手改**。

## A. 发布新版本(release + 部署)

1. **改版本号**(两处):`package.json` `version` → `X.Y.Z`;`src/sw.ts` `CACHE_NAME` → `picpilot-vX.Y.Z`。
2. **发布前验证**(全绿才继续):
   ```bash
   cd /root/picpilot
   bun run build            # typecheck + vite build + sw（产物 dist/sw.js 应含新缓存名）
   bun run test             # 前端 vitest
   (cd server && bun test)  # 后端集成/单测
   bun run lint             # 须 0 error
   ```
3. **提交并推 main**(沿用 `release: vX —` 约定):
   ```bash
   git add package.json src/sw.ts
   git commit -m "release: vX.Y.Z — <一句话摘要>"
   git push origin main
   ```
4. **打 tag 并推送**(触发 GitHub Actions:`docker.yml`→ghcr 镜像、`deploy.yml`→GH Pages;**与本机生产部署相互独立**):
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z — <摘要>"
   git push origin vX.Y.Z
   ```
5. **本机生产部署**(传**不带 v** 的版本号):
   ```bash
   bash /opt/docker_file/deploy.sh X.Y.Z
   ```
   `deploy.sh` 依次执行:`git pull` → `PICPILOT_VERSION=X.Y.Z docker compose build frontend auth` → `up -d frontend auth` → 校验容器已起 → `docker image prune -f`。脚本带 `set -e`,**构建失败会在重启前中止**(无故障停机)。

## B. 仅重新部署(代码已在 main、不升版本)

```bash
bash /opt/docker_file/deploy.sh <版本号>
```
不带参数时,`deploy.sh` 用 `git describe --tags --exact-match`(无 tag 则用 short commit hash)作为版本。

### deploy.sh 的手动等价(脚本不可用时)
```bash
cd /root/picpilot && git pull
cd /opt/docker_file
PICPILOT_VERSION=X.Y.Z docker compose build frontend auth
PICPILOT_VERSION=X.Y.Z docker compose up -d frontend auth
```

## C. 部署后验证(必做)

```bash
# 1) 两个容器都 Up 且不在重启循环
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | grep picpilot

# 2) 后端已监听（确认 server/index.ts 的 import.meta.main 守卫在生产生效）
docker logs docker_file-auth-1 --tail 30 | grep "picpilot ready"

# 3) 端到端经 caddy + TLS（应 HTTP 200）
curl -sk --resolve image.xxww.online:443:127.0.0.1 -w "\nHTTP %{http_code}\n" https://image.xxww.online/

# 4) 线上 SW 缓存名 = 新版本（确认新版已上线、客户端缓存会刷新）
curl -sk --resolve image.xxww.online:443:127.0.0.1 https://image.xxww.online/sw.js | grep -o "picpilot-v[0-9.]*"
```

## D. 回滚

- **优先**:上一版镜像通常仍在本机(`deploy.sh` 的 prune 只删 dangling 镜像),直接切回:
  ```bash
  cd /opt/docker_file
  PICPILOT_VERSION=<旧版本> docker compose up -d frontend auth
  ```
- 若旧镜像已不在,回到旧源码重建:
  ```bash
  cd /root/picpilot && git checkout v<旧版本>
  bash /opt/docker_file/deploy.sh <旧版本>
  git checkout main           # 别忘了切回 main
  ```

## E. 排查 / 注意事项

- **日志**:auth `docker logs docker_file-auth-1`(可加 `-f`/`--tail 200`/`--since 1h`);前端 `docker logs docker_file-frontend-1`;cliproxy 出图路由与耗时见 `/opt/docker_file/data/cliproxy/logs/main.log`(`error-*.log` 为单请求错误快照);caddy `docker logs docker_file-caddy-1`。
- **后端 Dockerfile 是白名单 COPY**:`server/Dockerfile` 只拷 `index.ts`/`config.ts`/`concurrencyQueue.ts`/`utils/`。**新增任何顶层 `server/*.ts`(拆出的路由、新 config 文件)必须同步加进 Dockerfile 的 `COPY`**,否则容器启动即崩、而本地 `bun run`/`bun test` 全绿——典型「本地绿、Docker 死」。约定:新常量进 `config.ts`、新纯函数进 `utils/`、新测试放 `server/` 根目录(不会被 COPY 进镜像)。
- **sharp**:`server/Dockerfile` 已装 `libvips42`;若构建报 sharp 相关错先查此。
- **frozen lockfile**:两个 Dockerfile 用 `bun install --frozen-lockfile`,改 `package.json` 依赖后务必同时提交 `bun.lock`,否则构建失败。
- **密钥**:`/opt/docker_file/.env`(`ADMIN_USERS`/`JWT_SECRET`/各 `*_KEY`)在仓库之外,**勿提交**;`data/`(`auth.db`、图片、cliproxy 配置)同理。
- **GH Actions ≠ 生产部署**:tag 触发的 ghcr 镜像与 GH Pages 与本机 `deploy.sh` 相互独立;生产以本机 compose 本地构建为准。
