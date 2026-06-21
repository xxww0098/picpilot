#!/bin/bash
# 从团队配置 / .env / cliproxyapi 解析 API Key（deploy/verify 健康检查用）

read_api_proxy_key() {
  local key=""
  local db_paths=(
    /opt/picpilot/data/picpilot/auth.db
    /opt/picpilot/data/auth.db
  )
  for db in "${db_paths[@]}"; do
    if [[ -f "$db" ]] && command -v sqlite3 >/dev/null 2>&1; then
      key="$(sqlite3 "$db" "SELECT json_extract(settings_json, '$.apiProxyApiKey') FROM team_config WHERE id=1;" 2>/dev/null || true)"
      key="$(printf '%s' "$key" | sed "s/^[\"']//;s/[\"']$//")"
      [[ -n "$key" ]] && printf '%s' "$key" && return 0
    fi
  done
  if [[ -f /opt/picpilot/.env ]]; then
    key="$(grep -E '^API_PROXY_API_KEY=' /opt/picpilot/.env | cut -d= -f2- | sed "s/^[\"']//;s/[\"']$//" || true)"
    [[ -n "$key" ]] && printf '%s' "$key" && return 0
  fi
  if [[ -f /opt/cliproxyapi/data/config/config.yaml ]]; then
    key="$(grep -A20 '^api-keys:' /opt/cliproxyapi/data/config/config.yaml | grep -E '^\s+-\s+' | head -1 | sed 's/^[[:space:]]*-[[:space:]]*//' || true)"
    [[ -n "$key" ]] && printf '%s' "$key" && return 0
  fi
  printf '%s' ""
}

upstream_models_ok_caddy() {
  local key
  key="$(read_api_proxy_key)"
  [[ -n "$key" ]] || return 1
  docker exec caddy wget -qO- --timeout=5 \
    --header="Authorization: Bearer ${key}" \
    http://cliproxyapi:8317/v1/models 2>/dev/null | grep -q '"data"'
}

upstream_models_ok_public() {
  local key code
  key="$(read_api_proxy_key)"
  [[ -n "$key" ]] || return 1
  code="$(curl -sk --resolve api.xxww.online:443:127.0.0.1 \
    -H "Authorization: Bearer ${key}" \
    -o /dev/null -w '%{http_code}' \
    https://api.xxww.online/v1/models)"
  [[ "$code" == "200" ]]
}
