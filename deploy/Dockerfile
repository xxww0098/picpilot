# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM caddy:2-alpine

COPY --from=build /app/dist /usr/share/caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
