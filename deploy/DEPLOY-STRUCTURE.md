# PicPilot + CLIProxyAPI 结构化部署设计（2026-06 重构）

目标：
- 容器/服务**互不影响**（即使服务器上有其他 Docker 项目、本地开发、多个实例）。
- **picpilot 完全单独部署**，cliproxyapi 也是独立项目。只通过环境变量描述上游接入。
- 配置永远不会因为“合并”而串掉。
- 清晰的启动顺序和网络边界。

## 推荐目录结构（生产 VPS）

```text
/opt/
├── cliproxyapi/                    # 独立项目，-p cliproxyapi
│   ├── compose.yml (或 docker-compose.yml)
│   ├── .env
│   ├── config.example.yaml   # 官方依赖文件（https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml）
│   └── data/
│       ├── config/config.yaml   # 必须从 config.example.yaml 复制并编辑
│       ├── auths/
│       ├── logs/
│       └── plugins/
│
├── picpilot/                    # 独立项目，-p picpilot
│   ├── compose.yml
│   ├── .env
│   ├── Caddyfile
│   └── data/
│       ├── picpilot/            # auth 的数据库等
│       ├── cliproxyapi-logs/       # ro 挂载（可选，用于日志查看）
│       └── dockercopilot/
│
└── （其他项目...）
```

## 核心隔离机制

1. **永远不使用 `container_name`**（全局唯一是万恶之源）。
   - Compose 自动生成 `<project>-<service>-<index>`，例如 `picpilot-auth-1`、`cliproxyapi-cli-proxy-api-1`。

2. **每个逻辑单元一个 Compose Project**（用 `-p` 或目录名控制）。
   - `docker compose -p cliproxyapi -f ... up -d`
   - `docker compose -p picpilot -f ... up -d`

3. **仅通过显式命名的网络共享**（最小耦合）。
   - cliproxyapi compose 创建并命名网络为 `cliproxyapi-net`（使用 `name:` 固定真实 Docker network 名）。
   - picpilot compose 把需要调用 cliproxyapi 的服务（caddy、auth）声明 `cliproxyapi-net: external: true` 并 attach。
   - 这样 auth 容器里 `http://cli-proxy-api:8317` 依然可达（Docker DNS 在共享网络上按 service 名解析）。
   - 其他服务（dockercopilot）留在各自项目的默认网络，不 join。

4. **数据完全隔离**。
   - cliproxyapi 的所有状态只在 `/opt/cliproxyapi/data/...`
   - picpilot 的状态只在 `/opt/picpilot/data/...`
   - 即使同时 mount 同一个物理路径，也通过不同 compose 上下文控制。

5. **端口**：
   - 只有入口点发布端口（caddy 的 80/443，或 cliproxyapi standalone 时的 HOST_* 映射）。
   - 内部通信走网络，不 publish 不必要的端口。

## 两个 Compose 文件（已拆分）

- `deploy/cliproxyapi/docker-compose.yml`（或 compose.yml）
  - 纯 cliproxyapi，可独立跑。
  - 负责创建 `cliproxyapi-net`（带 `name: cliproxyapi-net`）。
  - 所有端口、卷路径都可通过 .env 定制。

- `deploy/picpilot/compose.yml`（生产主栈备份）
  - picpilot 全栈（caddy + auth + dockercopilot + 对 cliproxyapi 的引用）。
  - 声明 `cliproxyapi-net` 为 external。
  - 只把 caddy 和 auth 加入该网络。
  - 启动前必须先有 cliproxyapi 容器 + 网络存在。

仓库里的 `deploy/docker-compose.yml` 是**遗留单文件模板**（供外部用户简单单机试用），不推荐生产混用。

## 典型操作流程

### 首次/清理后部署（强烈推荐用隔离脚本）

```bash
# 1. 同步配置（从源码）
cp deploy/cliproxyapi/docker-compose.yml /opt/cliproxyapi/compose.yml
cp deploy/cliproxyapi/.env.example     /opt/cliproxyapi/.env
# 编辑 /opt/cliproxyapi/.env 填好真实路径和端口

cp deploy/picpilot/compose.yml           /opt/picpilot/compose.yml
cp deploy/picpilot/Caddyfile          /opt/picpilot/Caddyfile
# 编辑 /opt/picpilot/.env

# 2. 启动（顺序重要）
cd /opt/cliproxyapi
docker compose -p cliproxyapi up -d

cd /opt/picpilot
docker compose -p picpilot up -d

# 3. 验证连通
docker exec picpilot-auth-1 curl -s http://cli-proxy-api:8317/v1/models | head -c 100
```

### 日常更新 cliproxyapi（不碰 picpilot）

```bash
cd /opt/cliproxyapi
docker compose pull
docker compose up -d
```

### 日常更新 picpilot 业务（auth/frontend）

使用项目原有的 `deploy.sh` 或手动 `docker compose -p picpilot up -d --build auth`。

### 想彻底拆分、甚至多个 cliproxyapi 给不同团队用

- 每个 cliproxyapi 实例一个目录 + 独立 `-p`
- 每个有自己的 `cliproxyapi-net-xxx`（或手动管理多个网络）
- 上层应用按需 `external` join 对应的网络，并在环境变量里写对应的 hostname（或用不同 service 别名）。

## 为什么这个设计能彻底解决“合并部署配置出错”？

- 以前的问题根源：同一个 compose 上下文里出现硬编码 `container_name`、相对卷冲突、service 名不一致、端口直接 publish。
- 新设计：项目边界清晰（-p + 目录）、名字永远带前缀、网络显式且最小共享、卷路径绝对且专属。
- 即使你以后在同一台机器上再加 10 个别的 Docker 项目，也不会互相踩。

## 回滚 / 应急

- cliproxyapi 坏了：只重启/回滚 cliproxyapi 项目，不影响 picpilot 其他容器（除了依赖它的功能）。
- 想临时让 picpilot 自己带一个内置 cliproxyapi：可以 fork 一个带 `include` 的单栈 compose（Compose 支持 `include:` 子 compose），但生产仍推荐上面分离模式。

---

维护提示：
- 改动实盘后，把对应文件 `cp` 回 `deploy/picpilot/` 和 `deploy/cliproxyapi/` 并提交（记得脱敏）。
- `deploy/isolate-cliproxyapi.sh` 可用来一键清理历史遗留的裸 `cli-proxy-api` 容器并按新结构启动。
