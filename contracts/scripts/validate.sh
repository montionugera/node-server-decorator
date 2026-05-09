#!/usr/bin/env bash
# contracts/scripts/validate.sh
# Validate every JSON fixture against its corresponding schema.
# Requires `ajv-cli` v5: `npm i -g ajv-cli@5`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS="$CONTRACTS_DIR/schemas"
FIXTURES="$CONTRACTS_DIR/fixtures"

if ! command -v ajv >/dev/null 2>&1; then
  echo "error: ajv-cli not on PATH. Install with: npm i -g ajv-cli@5" >&2
  exit 2
fi

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }

fail=0

# valid fixtures: must validate
for fixture in "$FIXTURES"/*.valid*.json; do
  [ -f "$fixture" ] || continue
  base=$(basename "$fixture")
  schema_name=$(echo "$base" | sed -E 's/\.valid([-.][a-zA-Z0-9_-]+)?\.json$//')
  schema="$SCHEMAS/$schema_name.schema.json"
  if [ ! -f "$schema" ]; then
    red "missing schema for $base (expected $schema)"
    fail=1
    continue
  fi
  if ajv validate -s "$schema" -d "$fixture" --strict=false --spec=draft2020 >/dev/null 2>&1; then
    green "OK   $base"
  else
    red "FAIL $base (should validate against $schema_name)"
    ajv validate -s "$schema" -d "$fixture" --strict=false --spec=draft2020 || true
    fail=1
  fi
done

# invalid fixtures: must NOT validate
for fixture in "$FIXTURES"/*.invalid*.json; do
  [ -f "$fixture" ] || continue
  base=$(basename "$fixture")
  schema_name=$(echo "$base" | sed -E 's/\.invalid([-.][a-zA-Z0-9_-]+)?\.json$//')
  schema="$SCHEMAS/$schema_name.schema.json"
  if [ ! -f "$schema" ]; then
    red "missing schema for $base (expected $schema)"
    fail=1
    continue
  fi
  if ajv validate -s "$schema" -d "$fixture" --strict=false --spec=draft2020 >/dev/null 2>&1; then
    red "FAIL $base (should NOT validate, but did)"
    fail=1
  else
    green "OK   $base (correctly rejected)"
  fi
done

# examples files (cache-key, tracking-event) just need to be parseable JSON
for examples in "$FIXTURES"/*.examples.json; do
  [ -f "$examples" ] || continue
  base=$(basename "$examples")
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$examples" >/dev/null 2>&1; then
    green "OK   $base (valid JSON)"
  else
    red "FAIL $base (not valid JSON)"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo
  green "All contract fixtures validate."
  exit 0
else
  echo
  red "Contract validation failed."
  exit 1
fi
