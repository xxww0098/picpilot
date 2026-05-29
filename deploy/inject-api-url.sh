#!/bin/sh

# 用环境变量替换前端默认 API URL。显式传入空字符串时保留为空。
DEFAULT_API_URL=${DEFAULT_API_URL-https://api.openai.com/v1}
API_PROXY_URL=${API_PROXY_URL:-https://api.openai.com/v1}
export DEFAULT_API_URL API_PROXY_URL

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

escape_js_string() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

DEFAULT_API_URL_ESCAPED=$(escape_sed_replacement "$(escape_js_string "$DEFAULT_API_URL")")

# 查找所有 js 文件并将占位符替换为运行时配置
find /usr/share/caddy/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$DEFAULT_API_URL_ESCAPED|g" {} +

exec "$@"
