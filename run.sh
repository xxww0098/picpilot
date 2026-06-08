#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 Node.js，请先安装 Node.js。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误: 未找到 npm，请先安装 npm。" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ">>> 首次启动，正在安装依赖..."
  npm install
fi

ensure_server_deps() {
  if [ ! -d server/node_modules ]; then
    echo ">>> 首次启动鉴权服务，正在安装服务端依赖..."
    npm install --prefix server
  fi
}

start_dev() {
  ensure_server_deps

  local auth_port="${AUTH_PORT:-3001}"
  local auth_url="http://localhost:${auth_port}"

  echo ">>> 启动 picpilot 开发模式..."
  echo ">>> 鉴权服务: ${auth_url}"
  echo ">>> 默认本地管理员: ${ADMIN_USERS:-admin:admin}"

  (
    cd server
    AUTH_PORT="$auth_port" \
      JWT_SECRET="${JWT_SECRET:-local-dev-jwt-secret-change-before-deploy}" \
      ADMIN_USERS="${ADMIN_USERS:-admin:admin}" \
      LOG_PRETTY="${LOG_PRETTY:-1}" \
      npm start
  ) &

  local auth_pid=$!
  trap 'kill "$auth_pid" 2>/dev/null || true' EXIT INT TERM

  LOCAL_AUTH_PROXY_URL="$auth_url" npm run dev -- "$@"
}

COMMAND="${1:-start}"
shift || true

case "$COMMAND" in
  dev)
    start_dev "$@"
    ;;
  start|local)
    echo ">>> 启动 picpilot 本地完整模式..."
    npm run start:local -- "$@"
    ;;
  build)
    echo ">>> 构建 picpilot..."
    npm run build -- "$@"
    ;;
  preview)
    echo ">>> 预览 picpilot 构建产物..."
    npm run preview -- "$@"
    ;;
  test)
    echo ">>> 运行测试..."
    npm test -- "$@"
    ;;
  typecheck)
    echo ">>> 运行类型检查..."
    npm run typecheck -- "$@"
    ;;
  install)
    echo ">>> 安装依赖..."
    npm install "$@"
    ;;
  -h|--help|help)
    cat <<'EOF'
Usage: ./run.sh [command] [args...]

Commands:
  dev        Start Vite development server
  start      Build and start the local Hono app (default)
  local      Alias for start
  build      Build production assets
  preview    Preview production build
  test       Run Vitest suite
  typecheck  Run TypeScript checks
  install    Install dependencies
EOF
    ;;
  *)
    echo "错误: 未知命令 '$COMMAND'。运行 ./run.sh help 查看可用命令。" >&2
    exit 1
    ;;
esac
