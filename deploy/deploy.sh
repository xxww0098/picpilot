#!/bin/bash
set -euo pipefail

COMPOSE_DIR="/opt/picpilot"
PROJECT_DIR="/root/picpilot"
COMPOSE_PROJECT="picpilot"
CLIPROXY_DIR="/opt/cliproxyapi"
CLIPROXY_PROJECT="cliproxyapi"
DC_DIR="/opt/dockercopilot"
DC_PROJECT="dockercopilot"
CADDY_DIR="/opt/caddy"
CADDY_PROJECT="caddy"

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_DIR/compose.yml" "$@"
}

cliproxy_compose() {
  docker compose -p "$CLIPROXY_PROJECT" -f "$CLIPROXY_DIR/compose.yml" "$@"
}

dc_compose() {
  docker compose -p "$DC_PROJECT" -f "$DC_DIR/compose.yml" "$@"
}

caddy_compose() {
  docker compose -p "$CADDY_PROJECT" -f "$CADDY_DIR/compose.yml" "$@"
}

resolve_version() {
  if [[ -n "${1:-}" ]]; then
    echo "$1"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -p "require('$PROJECT_DIR/package.json').version"
    return
  fi
  cd "$PROJECT_DIR"
  git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD
}

ensure_cliproxyapi() {
  if docker network inspect cliproxyapi-net >/dev/null 2>&1 \
    && docker ps --format '{{.Names}}' | grep -q '^cliproxyapi$'; then
    return 0
  fi
  echo ">>> cliproxyapi 未就绪，先启动..."
  [[ -f "$CLIPROXY_DIR/compose.yml" ]] || { echo "!!! 缺少 $CLIPROXY_DIR/compose.yml" >&2; exit 1; }
  cd "$CLIPROXY_DIR" && cliproxy_compose up -d && sleep 2
}

ensure_dockercopilot() {
  if docker network inspect dockercopilot-net >/dev/null 2>&1 \
    && docker ps --format '{{.Names}}' | grep -q '^dockercopilot$'; then
    return 0
  fi
  echo ">>> dockercopilot 未就绪，先启动..."
  [[ -f "$DC_DIR/compose.yml" ]] || { echo "!!! 缺少 $DC_DIR/compose.yml" >&2; exit 1; }
  cd "$DC_DIR" && dc_compose up -d && sleep 2
}

ensure_caddy() {
  if docker ps --format '{{.Names}}' | grep -q '^caddy$'; then
    return 0
  fi
  echo ">>> caddy 未就绪，先启动..."
  [[ -f "$CADDY_DIR/compose.yml" ]] || { echo "!!! 缺少 $CADDY_DIR/compose.yml" >&2; exit 1; }
  cd "$CADDY_DIR" && caddy_compose up -d && sleep 2
}

verify_deploy() {
  local version="$1"
  echo ">>> 健康检查..."

  docker ps --format '{{.Image}}' | grep -q "picpilot-api:$version" || {
    echo "❌ picpilot 未使用 picpilot-api:$version" >&2
    compose logs --tail=30 picpilot
    exit 1
  }

  docker logs picpilot --tail 20 2>&1 | grep -q '"component":"go-server"' || {
    echo "❌ picpilot 未以 go-server 启动" >&2
    compose logs --tail=30 picpilot
    exit 1
  }

  local code
  code=$(curl -sk --resolve image.xxww.online:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://image.xxww.online/)
  [[ "$code" == "200" ]] || { echo "❌ image.xxww.online → HTTP $code" >&2; exit 1; }

  docker exec caddy wget -qO- --timeout=5 http://cliproxyapi:8317/v1/models 2>/dev/null | grep -q '"data"' || {
    echo "❌ caddy 无法访问 cliproxyapi:8317" >&2
    exit 1
  }

  code=$(curl -sk --resolve api.xxww.online:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.xxww.online/v1/models)
  [[ "$code" == "200" ]] || { echo "❌ api.xxww.online → HTTP $code" >&2; exit 1; }

  echo "✅ 部署成功: $version"
  echo "   image.xxww.online → HTTP 200"
  echo "   api.xxww.online   → HTTP 200"
  curl -sk --resolve image.xxww.online:443:127.0.0.1 https://image.xxww.online/sw.js | grep -o 'picpilot-v[0-9.]*' | head -1 || true
}

main() {
  local version
  version="$(resolve_version "${1:-}")"

  echo ">>> 拉取最新代码..."
  cd "$PROJECT_DIR" && git pull

  echo ">>> 部署版本: $version"
  ensure_cliproxyapi
  ensure_dockercopilot

  echo ">>> 构建镜像..."
  cd "$COMPOSE_DIR"
  PICPILOT_VERSION="$version" compose build picpilot

  echo ">>> 启动 picpilot..."
  PICPILOT_VERSION="$version" compose up -d --remove-orphans picpilot

  echo ">>> 启动/重载 caddy..."
  ensure_caddy
  cd "$CADDY_DIR" && caddy_compose up -d

  sleep 3
  verify_deploy "$version"

  echo ">>> 清理悬空镜像..."
  docker image prune -f

  echo ">>> 完成!"
  docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
}

main "${1:-}"