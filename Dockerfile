# ── Build stage ────────────────────────────────────────────────────────────
FROM golang:1.24-alpine AS builder

RUN apk add --no-cache git

WORKDIR /src
COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/godraw ./cmd/draw

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata
RUN adduser -D -u 1000 godraw

COPY --from=builder /bin/godraw /usr/local/bin/godraw

RUN mkdir -p /data/drawings /data/uploads && chown -R godraw:godraw /data

USER godraw
WORKDIR /data

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8090/health || exit 1

ENTRYPOINT ["godraw"]
