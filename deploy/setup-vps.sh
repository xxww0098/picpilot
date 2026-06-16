#!/bin/bash
# 首次部署或 VPS 重建时，从仓库同步配置到 /opt 并准备数据目录。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ">>> 准备 cliproxyapi (/opt/cliproxyapi)"
mkdir -p /opt/cliproxyapi/data/{config,auths,logs,plugins}
cp "$ROOT/deploy/cliproxyapi/compose.yml" /opt/cliproxyapi/compose.yml
cp "$ROOT/deploy/cliproxyapi/config.example.yaml" /opt/cliproxyapi/config.example.yaml
[[ -f /opt/cliproxyapi/.env ]] || cp "$ROOT/deploy/cliproxyapi/.env.example" /opt/cliproxyapi/.env
[[ -f /opt/cliproxyapi/data/config/config.yaml ]] || {
  if [[ -f "$ROOT/deploy/cliproxyapi/config.yaml" ]]; then
    cp "$ROOT/deploy/cliproxyapi/config.yaml" /opt/cliproxyapi/data/config/config.yaml
  else
    cp /opt/cliproxyapi/config.example.yaml /opt/cliproxyapi/data/config/config.yaml
  fi
}
cp "$ROOT/deploy/update-cliproxyapi.sh" /opt/cliproxyapi/update-cliproxyapi.sh
chmod +x /opt/cliproxyapi/update-cliproxyapi.sh

echo ">>> 准备 dockercopilot (/opt/dockercopilot)"
mkdir -p /opt/dockercopilot/data
cp "$ROOT/deploy/dockercopilot/compose.yml" /opt/dockercopilot/compose.yml
if [[ -f /opt/picpilot/.env ]] && grep -q '^DOCKERCOPILOT_SECRET=' /opt/picpilot/.env; then
  grep '^DOCKERCOPILOT_SECRET=' /opt/picpilot/.env > /opt/dockercopilot/.env
elif [[ -f /opt/dockercopilot/.env ]]; then
  :
else
  cp "$ROOT/deploy/dockercopilot/.env.example" /opt/dockercopilot/.env
fi
if [[ -d /opt/picpilot/data/dockercopilot ]] && [[ ! -e /opt/dockercopilot/data/config ]]; then
  cp -a /opt/picpilot/data/dockercopilot/. /opt/dockercopilot/data/ 2>/dev/null || true
fi

echo ">>> 准备 caddy (/opt/caddy)"
mkdir -p /opt/caddy
cp "$ROOT/deploy/caddy/compose.yml" /opt/caddy/compose.yml
if [[ -f /opt/picpilot/Caddyfile ]]; then
  cp /opt/picpilot/Caddyfile /opt/caddy/Caddyfile
else
  cp "$ROOT/deploy/caddy/Caddyfile" /opt/caddy/Caddyfile
fi

echo ">>> 准备 picpilot (/opt/picpilot)"
mkdir -p /opt/picpilot/data/picpilot
cp "$ROOT/deploy/picpilot/compose.yml" /opt/picpilot/compose.yml
[[ -f /opt/picpilot/.env ]] || cp "$ROOT/deploy/picpilot/.env.example" /opt/picpilot/.env
cp "$ROOT/deploy/deploy.sh" /opt/picpilot/deploy.sh
cp "$ROOT/deploy/verify-vps.sh" /opt/picpilot/verify-vps.sh
cp "$ROOT/deploy/cleanup-vps.sh" /opt/picpilot/cleanup-vps.sh
cp "$ROOT/deploy/isolate-cliproxyapi.sh" /opt/picpilot/isolate-cliproxyapi.sh
chmod +x /opt/picpilot/deploy.sh /opt/picpilot/verify-vps.sh /opt/picpilot/cleanup-vps.sh /opt/picpilot/isolate-cliproxyapi.sh

echo ">>> 链接 cliproxyapi 日志到 picpilot（只读）"
LOG_LINK="/opt/picpilot/data/cliproxyapi-logs"
LOG_SRC="/opt/cliproxyapi/data/logs"
if [[ -L "$LOG_LINK" ]]; then
  :
elif [[ -d "$LOG_LINK" && -z "$(ls -A "$LOG_LINK" 2>/dev/null)" ]]; then
  rmdir "$LOG_LINK"
  ln -sfn "$LOG_SRC" "$LOG_LINK"
elif [[ ! -e "$LOG_LINK" ]]; then
  ln -sfn "$LOG_SRC" "$LOG_LINK"
else
  echo "    保留现有 $LOG_LINK（非空目录，请手动核对）"
fi

echo ">>> 写入默认 PICPILOT_VERSION 到 .env"
if grep -q '^PICPILOT_VERSION=' /opt/picpilot/.env; then
  ver="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.28)"
  sed -i "s/^PICPILOT_VERSION=.*/PICPILOT_VERSION=$ver/" /opt/picpilot/.env
else
  ver="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.28)"
  echo "PICPILOT_VERSION=$ver" >> /opt/picpilot/.env
fi

echo ""
echo "✅ 配置已同步。下一步："
echo "   1. 编辑 /opt/cliproxyapi/.env、/opt/dockercopilot/.env、/opt/picpilot/.env"
echo "   2. cd /opt/cliproxyapi && docker compose -p cliproxyapi up -d"
echo "   3. cd /opt/dockercopilot && docker compose -p dockercopilot up -d"
echo "   4. cd /opt/picpilot && docker compose -p picpilot up -d picpilot"
echo "   5. cd /opt/caddy && docker compose -p caddy up -d"