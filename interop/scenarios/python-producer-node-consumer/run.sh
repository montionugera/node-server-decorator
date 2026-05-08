#!/usr/bin/env bash
# Run the Python-producer / Node-consumer interop scenario.
# Requires Docker (or a Redis running at $REDIS_URL).
set -euo pipefail

cd "$(dirname "$0")/../../.."

cleanup() { docker compose -f interop/docker-compose.yml down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "${REDIS_URL:-}" ]; then
  docker compose -f interop/docker-compose.yml up -d redis >/dev/null
  for i in $(seq 1 30); do
    if docker compose -f interop/docker-compose.yml exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
      break
    fi
    sleep 0.5
  done
  export REDIS_URL="redis://localhost:6379"
fi
export INTEROP_STREAM="interop-${RANDOM}"

# Producer: Python
( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/python-producer-node-consumer/producer.py
  else
    python3 -m pip install --quiet -e . redis >/dev/null
    python3 ../interop/scenarios/python-producer-node-consumer/producer.py
  fi )

# Consumer: Node
( cd node && pnpm install --frozen-lockfile >/dev/null && \
  pnpm exec tsx ../interop/scenarios/python-producer-node-consumer/consumer.ts )

echo "interop: python-producer / node-consumer PASSED"
