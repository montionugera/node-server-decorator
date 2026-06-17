#!/usr/bin/env bash
# Run the Node-emit / Python-consume interop scenario.
# Node writes to a Redis stream; Python consumes via @on_event + RedisStreamConsumer.
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

# Producer: build & run the Node script.
# NODE_PATH points module resolution at node/node_modules because the scenario .ts files
# live outside the node/ package tree (the same constraint applies to all interop scenarios).
( cd node && pnpm install --frozen-lockfile >/dev/null && \
  NODE_PATH="$PWD/node_modules" pnpm exec tsx ../interop/scenarios/node-emit-python-consume/producer.ts )

# Consumer: run the Python script
( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/node-emit-python-consume/consumer.py
  else
    python3 -m pip install --quiet -e . redis jsonschema >/dev/null
    python3 ../interop/scenarios/node-emit-python-consume/consumer.py
  fi )

echo "interop: node-emit / python-consume PASSED"
