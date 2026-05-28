# 常见错误与解决方案

## API 代理连通性测试失败 (404/405)

### 症状

前端「测试连通性」返回 404 或 405 错误，但直接访问 API 端点正常。

### 原因

**1. Caddyfile 路由冲突**

Caddyfile 中存在两个冲突的路由规则：

```caddyfile
# 规则1: matcher - 仅匹配 GET/POST/OPTIONS
@api_proxy_allowed {
    path /api-proxy/*
    method GET POST OPTIONS
}
handle @api_proxy_allowed {
    reverse_proxy auth:3001
}

# 规则2: 通配 - 匹配所有路径（优先级更高）
handle /api-proxy/* {
    respond "Method Not Allowed" 405
}
```

Caddy 处理 `handle` 块时，`handle /api-proxy/*` 优先于 `@api_proxy_allowed` matcher，导致 GET 请求被返回 405。

**2. API_PROXY_URL 缺少 /v1 后缀**

```bash
# 错误
API_PROXY_URL=http://cli-proxy-api:8317

# 正确
API_PROXY_URL=http://cli-proxy-api:8317/v1
```

### 修复

**1. 修改 Caddyfile**

删除 `handle /api-proxy/` 规则，只保留 matcher：

```caddyfile
@api_proxy_allowed {
    path /api-proxy/*
    method GET POST OPTIONS
}
handle @api_proxy_allowed {
    reverse_proxy auth:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        transport http {
            dial_timeout 60s
            response_header_timeout 600s
            read_timeout 600s
            write_timeout 600s
        }
    }
}

# 仅处理非允许的 HTTP 方法
handle /api-proxy/* {
    respond "Method Not Allowed" 405
}
```

**2. 修改 .env**

```bash
API_PROXY_URL=http://cli-proxy-api:8317/v1
```

**3. 重新部署**

```bash
docker compose up -d --build
docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

### 验证

```bash
# 获取 token
TOKEN=$(curl -s https://your-domain/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# 测试连通性
curl https://your-domain/api-proxy/models \
  -H "X-PicPilot-Authorization: Bearer $TOKEN"
```

返回模型列表即表示修复成功。