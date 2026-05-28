#!/bin/sh

# 用环境变量替换前端默认 API URL。显式传入空字符串时保留为空。
DEFAULT_API_URL=${DEFAULT_API_URL-https://api.openai.com/v1}
API_PROXY_URL=${API_PROXY_URL:-https://api.openai.com/v1}
export DEFAULT_API_URL API_PROXY_URL

API_PROXY_AVAILABLE=false
if [ "$ENABLE_API_PROXY" = "true" ]; then
    API_PROXY_AVAILABLE=true
fi

API_PROXY_LOCKED=false
if [ "$ENABLE_API_PROXY" = "true" ] && [ "$LOCK_API_PROXY" = "true" ]; then
    API_PROXY_LOCKED=true
fi

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

escape_js_string() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

DEFAULT_API_URL_ESCAPED=$(escape_sed_replacement "$(escape_js_string "$DEFAULT_API_URL")")

# 查找所有 js 文件并将占位符替换为运行时配置
find /usr/share/caddy/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$DEFAULT_API_URL_ESCAPED|g" {} +
find /usr/share/caddy/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__|$API_PROXY_AVAILABLE|g" {} +
find /usr/share/caddy/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_LOCKED_PLACEHOLDER__|$API_PROXY_LOCKED|g" {} +
find /usr/share/caddy/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__|true|g" {} +

# 检查是否启用了 API 代理
if [ "$ENABLE_API_PROXY" != "true" ]; then
    sed -i '/# BEGIN API PROXY/,/# END API PROXY/d' /etc/caddy/Caddyfile
    # 折叠连续空行，避免 sed 删块后留下双空行触发 Caddy "not formatted" 警告
    awk '/^[[:space:]]*$/{if(blank)next;blank=1;print;next}{blank=0;print}' /etc/caddy/Caddyfile > /tmp/Caddyfile.tmp \
        && mv /tmp/Caddyfile.tmp /etc/caddy/Caddyfile
fi

exec "$@"
