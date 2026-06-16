#!/bin/bash
set -euo pipefail

# 按拆分结构清理遗留容器并启动 cliproxyapi + picpilot 两个独立 compose 项目。

CLIPROXY_DIR="${CLIPROXY_DIR:-/opt/cliproxyapi}"
PICPILOT_DIR="${PICPILOT_DIR:-/opt/picpilot}"

echo ">>> [isolate-cliproxyapi] 清理遗留容器..."
docker rm -f cli-proxy-api cliproxy cliproxyapi-cli-proxy-api-1 picpilot-cliproxyapi-1 2>/dev/null || true

echo ">>> 启动 cliproxyapi ($CLIPROXY_DIR)"
[[ -f "$CLIPROXY_DIR/compose.yml" ]] || { echo "!!! 缺少 $CLIPROXY_DIR/compose.yml" >&2; exit 1; }
cd "$CLIPROXY_DIR"
docker compose -p cliproxyapi up -d

echo ">>> 启动 picpilot ($PICPILOT_DIR)"
[[ -f "$PICPILOT_DIR/compose.yml" ]] || { echo "!!! 缺少 $PICPILOT_DIR/compose.yml" >&2; exit 1; }
cd "$PICPILOT_DIR"
# 从 package.json 或 .env 读取版本
VERSION="${PICPILOT_VERSION:-$(node -p "require('/root/picpilot/package.json').version" 2>/dev/null || grep '^PICPILOT_VERSION=' .env | cut -d= -f2)}"
PICPILOT_VERSION="$VERSION" docker compose -p picpilot up -d --remove-orphans

sleep 3
bash "$PICPILOT_DIR/verify-vps.sh" 2>/dev/null || bash /root/picpilot/deploy/verify-vps.sh