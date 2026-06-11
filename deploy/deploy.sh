#!/bin/bash
set -e

COMPOSE_DIR="/opt/picpilot"
PROJECT_DIR="/root/picpilot"

cd "$PROJECT_DIR"

# 1. 拉取最新代码
echo ">>> 拉取最新代码..."
git pull

# 2. 获取版本号（优先用参数，否则从 git tag/commit 获取）
if [ -n "$1" ]; then
    VERSION="$1"
else
    # 尝试获取当前 tag，没有则用 short commit hash
    VERSION=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
fi
echo ">>> 部署版本: $VERSION"

# 3. 构建带版本标签的镜像（auth 单镜像内含前端静态文件）
echo ">>> 构建镜像..."
cd "$COMPOSE_DIR"
PICPILOT_VERSION="$VERSION" docker compose build auth

# 4. 启动新容器（Compose 检测到镜像变化会自动更新；--remove-orphans 清理已下线的旧 frontend 容器）
echo ">>> 启动新版本..."
PICPILOT_VERSION="$VERSION" docker compose up -d --remove-orphans auth

# 5. 等待容器启动
sleep 3

# 6. 验证部署
echo ">>> 验证部署..."
if docker ps | grep -q "picpilot-auth:$VERSION"; then
    echo "✅ 部署成功: $VERSION"
else
    echo "❌ 部署失败，请检查日志"
    docker compose logs --tail=20 auth
    exit 1
fi

# 7. 清理旧镜像
echo ">>> 清理旧镜像..."
docker image prune -f

echo ">>> 完成!"
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
