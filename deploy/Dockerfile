# ---- Build stage ----
FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ---- Production stage ----
FROM caddy:2-alpine

COPY --from=build /app/dist /usr/share/caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
