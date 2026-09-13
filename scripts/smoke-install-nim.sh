#!/usr/bin/env bash
# Post-tag smoke test (F-007): the Nim package installs at <tag> the way nim/README.md documents.
# ?subdir=nim is required because the .nimble lives in nim/, not at the repository root.
# Usage: scripts/smoke-install-nim.sh <tag>       e.g. v2.0.5
set -euo pipefail

tag="${1:?usage: smoke-install-nim.sh <tag>}"
url="https://github.com/montionugera/node-server-decorator?subdir=nim@#$tag"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

nimble --version | head -n 1
nimble install -y --nimbleDir:"$work/nimble" "$url"

if ! compgen -G "$work/nimble/pkgs2/server_decorator-*" >/dev/null; then
  echo "FAIL: server_decorator missing from $work/nimble/pkgs2 after install" >&2
  exit 1
fi
echo "OK: server_decorator installs from $url"
