# Single app image: Go backend + built frontend (dist/) served via STATIC_DIR.
# IMPORTANT: build context is the REPO ROOT, not server-go/ —
#   docker build -f server-go/Dockerfile .
# (compose files and .github/workflows/docker.yml are set up accordingly)

# ---- frontend build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- go build stage ----
FROM --platform=$BUILDPLATFORM golang:1.26 AS build

WORKDIR /src

# Cache module downloads.
COPY server-go/go.mod server-go/go.sum ./
RUN go mod download

COPY server-go/ ./

# CGO_ENABLED=0 -> fully static binary (pure-Go SQLite + image libs, no libvips/gcc).
# TARGETOS/TARGETARCH come from BuildKit; cross-compiling beats qemu for multi-arch.
ARG APP_VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build \
    -trimpath \
    -ldflags "-s -w -X main.AppVersion=${APP_VERSION}" \
    -o /server .

# ---- runtime stage ----
# distroless/static ships ca-certificates (for outbound HTTPS to the upstream API) and
# is the smallest base that works for a CGO-free static binary.
FROM gcr.io/distroless/static-debian12

COPY --from=build /server /server
COPY --from=frontend /app/dist /app/dist

ENV HOST=0.0.0.0 \
    AUTH_PORT=3001 \
    DATA_DIR=/data \
    DB_PATH=/data/auth.db \
    STATIC_DIR=/app/dist

EXPOSE 3001
VOLUME ["/data"]

# JWT_SECRET, ADMIN_USERS, API_PROXY_URL, API_PROXY_API_KEY, etc. are supplied at runtime.
ENTRYPOINT ["/server"]
