#!/usr/bin/env bash
# Assert every published package (Node + Python + Go + Nim) is at the same version (Decision #2, ADR 0007).
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

versions=""
for pkg in node/packages/*/package.json; do
  v=$(node -p "require('./$pkg').version")
  versions+="$pkg=$v\n"
done
for pkg in python/packages/*/pyproject.toml; do
  v=$(grep -oE '^version\s*=\s*"[^"]+"' "$pkg" | grep -oE '"[^"]+"' | tr -d '"')
  versions+="$pkg=$v\n"
done
# _version.py is the runtime `__version__` export consumers actually read (see I1) — check
# it stays in lockstep with pyproject.toml, not just Node/Python across packages.
for v in python/packages/*/src/*/_version.py; do
  ver=$(grep -oE '^__version__\s*=\s*"[^"]+"' "$v" | grep -oE '"[^"]+"' | tr -d '"')
  versions+="$v=$ver\n"
done

# go/entity/version.go is the Go module's runtime version constant (I-006).
go_v=$(grep -oE '^const Version = "[^"]+"' go/entity/version.go | grep -oE '"[^"]+"' | tr -d '"') \
  || { echo "FAIL: no 'const Version = \"x.y.z\"' in go/entity/version.go" >&2; exit 1; }
versions+="go/entity/version.go=$go_v\n"

# go/adapter/gin is its own module; its `require` of the root module must name this release,
# or the adapter tagged go/adapter/gin/vX.Y.Z would pull a different root version.
gin_v=$(grep -oE '^[[:space:]]*github.com/montionugera/node-server-decorator/v2 v[^[:space:]]+' go/adapter/gin/go.mod | grep -oE '[^[:space:]]+$' | sed 's/^v//') \
  || { echo "FAIL: no 'require github.com/montionugera/node-server-decorator/v2 vX.Y.Z' in go/adapter/gin/go.mod" >&2; exit 1; }
versions+="go/adapter/gin/go.mod[require root]=$gin_v\n"

# nim/server_decorator.nimble is the Nim package's only version source (F-006); nimble reads it.
nim_v=$(grep -oE '^version[[:space:]]*=[[:space:]]*"[^"]+"' nim/server_decorator.nimble | grep -oE '"[^"]+"' | tr -d '"') \
  || { echo "FAIL: no 'version = \"x.y.z\"' in nim/server_decorator.nimble" >&2; exit 1; }
versions+="nim/server_decorator.nimble=$nim_v\n"

# rust/Cargo.toml is the Rust workspace's version source.
rust_v=$(grep -oE '^version\s*=\s*"[^"]+"' rust/Cargo.toml | grep -oE '"[^"]+"' | tr -d '"') \
  || { echo "FAIL: no 'version = \"x.y.z\"' in rust/Cargo.toml" >&2; exit 1; }
versions+="rust/Cargo.toml=$rust_v\n"
# Internal crate deps in [workspace.dependencies] must carry that same version (crates.io publish).
while IFS= read -r line; do
  dep=${line%%[[:space:]=]*}
  dep_v=$(printf '%s' "$line" | grep -oE 'version[[:space:]]*=[[:space:]]*"[^"]+"' | grep -oE '"[^"]+"' | tr -d '"')
  versions+="rust/Cargo.toml[$dep]=$dep_v\n"
done < <(grep -E '^server-decorator-' rust/Cargo.toml)

count=$(printf "%b" "$versions" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')
if [ "$count" != "1" ]; then
  echo "FAIL: package versions diverge:" >&2
  printf "%b" "$versions" >&2
  echo "Run scripts/bump-version.sh to re-sync." >&2
  exit 1
fi
echo "OK: all packages at $(printf "%b" "$versions" | head -1 | cut -d= -f2)"
