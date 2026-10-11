#!/usr/bin/env bash
# Run: bash scripts/tests/ci-action-majors.test.sh   (offline: every pinned action is on a Node 24 major)
# Majors below were checked with `gh api repos/<o>/<r>/contents/action.yml?ref=<tag>` (runs.using: node24, or composite).
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; fail=0
want(){ # action  required-ref
  local bad; bad=$(grep -hoE "uses: *$1@[^ ]+" "$R"/.github/workflows/*.yml | grep -v "@$2\$" | sort -u)
  if [ -z "$bad" ]; then echo "ok - $1 is on $2"; else echo "FAIL - $1 not on $2: $bad"; fail=1; fi
}
want actions/checkout v7
want actions/setup-go v7
want pnpm/action-setup v6
want astral-sh/setup-uv v7
# setup-node stays on v6: v7 stops exporting the dummy NODE_AUTH_TOKEN, which the keyless npmjs trusted-publishing step's .npmrc needs.
want actions/setup-node v6
want rust-lang/crates-io-auth-action v1
want jiro4989/setup-nim-action v2
want pypa/gh-action-pypi-publish release/v1
# setup-uv v5+ turns the cache on by default; the old v3 runs had none, so keep it off.
n=$(grep -c 'astral-sh/setup-uv@' "$R"/.github/workflows/*.yml | awk -F: '{s+=$2} END{print s}')
c=$(grep -A2 'astral-sh/setup-uv@' "$R"/.github/workflows/*.yml | grep -c 'enable-cache: false')
if [ "$n" = "$c" ]; then echo "ok - every setup-uv step sets enable-cache: false"; else echo "FAIL - setup-uv steps: $n, with enable-cache false: $c"; fail=1; fi
exit "$fail"
