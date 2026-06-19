#!/usr/bin/env bash
# Run the Kafka Node-emit / Python-consume interop scenario.
# Node produces envelopes to a Kafka topic via kafkajs; Python consumes via
# @on_event + KafkaConsumer (aiokafka consumer group). Requires Docker.
set -euo pipefail

cd "$(dirname "$0")/../../.."

cleanup() { docker compose -f interop/docker-compose.yml down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Bring up Kafka (single-broker KRaft). Startup is slow; give it generous retries.
docker compose -f interop/docker-compose.yml up -d kafka >/dev/null
echo "waiting for kafka broker..."
for i in $(seq 1 90); do
  if docker compose -f interop/docker-compose.yml exec -T kafka \
       kafka-broker-api-versions --bootstrap-server localhost:9092 >/dev/null 2>&1; then
    echo "kafka ready after ${i} checks"
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "kafka did not become ready in time" >&2
    exit 1
  fi
  sleep 1
done

export KAFKA_BROKER="localhost:9092"

# Producer: build & run the Node script.
# NODE_PATH points module resolution at node/node_modules because the scenario .ts files
# live outside the node/ package tree (the same constraint applies to all interop scenarios).
( cd node && pnpm install --frozen-lockfile >/dev/null && \
  NODE_PATH="$PWD/node_modules" pnpm exec tsx ../interop/scenarios/kafka-node-emit-python-consume/producer.ts )

# Consumer: run the Python script
( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/kafka-node-emit-python-consume/consumer.py
  else
    python3 -m pip install --quiet -e ".[kafka]" jsonschema >/dev/null
    python3 ../interop/scenarios/kafka-node-emit-python-consume/consumer.py
  fi )

echo "interop: kafka node-emit / python-consume PASSED"
