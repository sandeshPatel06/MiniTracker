# =====================================================================
# Optimized Multi-stage Dockerfile for get-Hike / MiniTracker backend
# - BuildKit cache mounts for rapid Go module & compile cache
# - Minimal layer dependencies
# - Ultra-minimal runtime container (~20MB)
# =====================================================================
FROM golang:1.26-alpine AS builder

# Install build tools & Cgo SQLite dependencies
RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /build

# 1. Cache dependency downloads independently of source code
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# 2. Copy only backend source code & Go files
COPY cmd/ ./cmd/
COPY internal/ ./internal/

# 3. Compile with CGO, stripped symbols (-s -w), and Go compiler cache
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -extldflags '-static'" \
    -tags "sqlite_omit_load_extension netgo" \
    -o /get-hike-server \
    ./cmd/server

# =====================================================================
# Production Runtime Stage (Ultra-minimal Alpine)
# =====================================================================
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata sqlite-libs && \
    mkdir -p /data/images && \
    chmod 755 /data

WORKDIR /app
COPY --from=builder /get-hike-server /app/get-hike-server

# Persistent storage volume for SQLite DB and screenshots
VOLUME ["/data"]

EXPOSE 8080

ENV DATA_DIR=/data \
    PORT=8080 \
    TZ=UTC

ENTRYPOINT ["/app/get-hike-server"]
