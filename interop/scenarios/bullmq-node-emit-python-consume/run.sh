#!/usr/bin/env bash
# Run the BullMQ Node-emit / Python-consume interop scenario (Plan-2 headline).
# Node enqueues jobs via the bullmq Queue; Python consumes via @on_event +
# BullMQConsumer (the official bullmq package's Worker). Requires Docker (Redis).
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
export INTEROP_QUEUE="OrderService.createOrder"

# Producer: build & run the Node script
( cd node && pnpm install --frozen-lockfile >/dev/null && \
  cd packages/core && pnpm exec tsx ../../../interop/scenarios/bullmq-node-emit-python-consume/producer.ts )

# Consumer: run the Python script
( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/bullmq-node-emit-python-consume/consumer.py
  else
    python3 -m pip install --quiet -e "packages/core[bullmq]" jsonschema >/dev/null
    python3 ../interop/scenarios/bullmq-node-emit-python-consume/consumer.py
  fi )

echo "interop: bullmq node-emit / python-consume PASSED"
