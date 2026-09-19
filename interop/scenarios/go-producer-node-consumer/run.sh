#!/usr/bin/env bash
# Run the Go-producer / Node-consumer interop scenario.
# Requires Docker (or a Redis running at $REDIS_URL).
set -euo pipefail

cd "$(dirname "$0")/../../.."

cleanup() { docker compose -f interop/docker-compose.yml down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "${REDIS_URL:-}" ]; then
  docker compose -f interop/docker-compose.yml up -d redis >/dev/null
  # Wait for healthcheck.
  for i in $(seq 1 30); do
    if docker compose -f interop/docker-compose.yml exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
      break
    fi
    sleep 0.5
  done
  export REDIS_URL="redis://localhost:6379"
fi
export INTEROP_STREAM="interop-${RANDOM}"

# Producer: run Go producer
CGO_ENABLED=0 go run ./interop/scenarios/go-producer-node-consumer/producer.go

# Consumer: run Node consumer
( cd node && pnpm install --frozen-lockfile >/dev/null && \
  cd packages/core && pnpm exec tsx ../../../interop/scenarios/go-producer-node-consumer/consumer.ts )

echo "interop: go-producer / node-consumer PASSED"
