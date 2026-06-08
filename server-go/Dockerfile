# ---- build stage ----
FROM golang:1.26 AS build

WORKDIR /src

# Cache module downloads.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0 -> fully static binary (pure-Go SQLite + image libs, no libvips/gcc).
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.AppVersion=${APP_VERSION}" \
    -o /server .

# ---- runtime stage ----
# distroless/static ships ca-certificates (for outbound HTTPS to the upstream API) and
# is the smallest base that works for a CGO-free static binary.
FROM gcr.io/distroless/static-debian12

COPY --from=build /server /server

ENV HOST=0.0.0.0 \
    AUTH_PORT=3001 \
    DATA_DIR=/data \
    DB_PATH=/data/auth.db

EXPOSE 3001
VOLUME ["/data"]

# JWT_SECRET, ADMIN_USERS, API_PROXY_URL, API_PROXY_API_KEY, etc. are supplied at runtime.
ENTRYPOINT ["/server"]
