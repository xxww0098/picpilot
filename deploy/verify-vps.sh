#!/bin/bash
set -euo pipefail

PASS=0
FAIL=0

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "✅ $name"
    PASS=$((PASS + 1))
  else
    echo "❌ $name"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== VPS 健康检查 ==="
echo ""

check "cliproxyapi 运行中" \
  bash -c "docker ps --format '{{.Names}}' | grep -q '^cliproxyapi$'"

check "caddy 运行中" \
  bash -c "docker ps --format '{{.Names}}' | grep -q '^caddy$'"

check "picpilot 运行中" \
  bash -c "docker ps --format '{{.Names}}' | grep -q '^picpilot$'"

check "dockercopilot 运行中" \
  bash -c "docker ps --format '{{.Names}}' | grep -q '^dockercopilot$'"

check "picpilot-net 存在" \
  bash -c "docker network inspect picpilot-net >/dev/null 2>&1"

check "caddy 在 picpilot-net" \
  bash -c "docker inspect caddy --format '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' | grep -q picpilot-net"

check "picpilot 在 picpilot-net" \
  bash -c "docker inspect picpilot --format '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' | grep -q picpilot-net"

check "caddy 在 cliproxyapi-net" \
  bash -c "docker inspect caddy --format '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' | grep -q cliproxyapi-net"

check "caddy 在 dockercopilot-net" \
  bash -c "docker inspect caddy --format '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' | grep -q dockercopilot-net"

check "dc.xxww.online 可达" \
  bash -c "code=\$(curl -sk --resolve dc.xxww.online:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://dc.xxww.online/manager); [[ \"\$code\" == \"200\" ]]"

check "picpilot 使用 go-server" \
  bash -c "docker logs picpilot --tail 30 2>&1 | grep -q '\"component\":\"go-server\"'"

check "image.xxww.online HTTP 200" \
  bash -c "[[ \"\$(curl -sk --resolve image.xxww.online:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://image.xxww.online/)\" == \"200\" ]]"

check "api.xxww.online HTTP 200" \
  bash -c "[[ \"\$(curl -sk --resolve api.xxww.online:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.xxww.online/v1/models)\" == \"200\" ]]"

check "caddy → cliproxyapi 可达" \
  bash -c "docker exec caddy wget -qO- --timeout=5 http://cliproxyapi:8317/v1/models 2>/dev/null | grep -q '\"data\"'"

check "cliproxyapi-logs 已链接" \
  bash -c "[[ -L /opt/picpilot/data/cliproxyapi-logs && -d /opt/picpilot/data/cliproxyapi-logs ]]"

echo ""
echo "=== 结果: $PASS 通过, $FAIL 失败 ==="
[[ "$FAIL" -eq 0 ]]