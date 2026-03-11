# Build stage
FROM golang:1.26-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Get version information
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o godraw \
    ./cmd/draw

# Production stage
FROM alpine:3.20

# Install CA certificates and create non-root user
RUN apk --no-cache add ca-certificates tzdata && \
    addgroup -g 1001 -S godraw && \
    adduser -u 1001 -S godraw -G godraw

# Create data directories with correct permissions
RUN mkdir -p /data/drawings /data/uploads && chown -R godraw:godraw /data

WORKDIR /app

# Copy binary from builder
COPY --from=builder --chown=godraw:godraw /build/godraw .

# Switch to non-root user
USER godraw

# Expose port
EXPOSE 8090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8090/health || exit 1

# Run the binary
CMD ["./godraw"]
