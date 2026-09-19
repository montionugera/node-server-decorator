#!/usr/bin/env bash
# Run the Go-producer / Python-consumer interop scenario.
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

# Producer: run pure standard library Go producer
CGO_ENABLED=0 go run ./interop/scenarios/go-producer-python-consumer/producer.go

# Consumer: run the Python script
( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/go-producer-python-consumer/consumer.py
  else
    python3 -m pip install --quiet -e packages/core redis jsonschema >/dev/null
    python3 ../interop/scenarios/go-producer-python-consumer/consumer.py
  fi )

echo "interop: go-producer / python-consumer PASSED"
