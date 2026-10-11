#!/usr/bin/env bash
# Bump ALL packages in lock-step (Decision #2, ADR 0007). Usage: scripts/bump-version.sh patch|minor|major
set -euo pipefail
shopt -s nullglob
bump=${1:?"usage: $0 patch|minor|major"}
case "$bump" in patch|minor|major) ;; *) echo "error: patch|minor|major" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

# Bump core first to compute the new version, then mirror everywhere.
( cd node/packages/core && pnpm version "$bump" --no-git-tag-version >/dev/null )
new_version=$(node -p "require('./node/packages/core/package.json').version")

for pkg in node/packages/*/package.json; do
  [ "$pkg" = "node/packages/core/package.json" ] && continue
  node -e "const f='$pkg',p=require('./'+f);p.version='$new_version';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
done
for pkg in python/packages/*/pyproject.toml; do
  sed -i.bak "s/^version = .*/version = \"$new_version\"/" "$pkg" && rm "$pkg.bak"
done
# The gen_* packages pin their intra-repo dependency on server-decorator-entity EXACTLY (I-f) —
# mirrors how `pnpm publish` rewrites Node's `workspace:*` to an exact version for the published
# wheel's Requires-Dist metadata (uv's `[tool.uv.sources] ... workspace = true` is dev-time-only
# and contributes nothing to the built wheel). Rewrite the pin in EVERY package that carries one,
# not just gen_pydantic, so a newly added package cannot ship a stale pin.
for pkg in python/packages/*/pyproject.toml; do
  grep -q '"server-decorator-entity==' "$pkg" || continue
  sed -i.bak -E "s/(\"server-decorator-entity)==[0-9]+\.[0-9]+\.[0-9]+(\")/\1==$new_version\2/" \
    "$pkg" && rm "$pkg.bak"
done
# Mirror into each package's runtime __version__ export (what `server_decorator.__version__`
# actually reads at import time) — pyproject.toml alone is invisible to consumers.
for v in python/packages/*/src/*/_version.py; do
  sed -i.bak "s/^__version__ = .*/__version__ = \"$new_version\"/" "$v" && rm "$v.bak"
done
# Mirror into the Go module's runtime version constant (I-006) — Go consumers read it, and
# check-versions.sh asserts it.
go_version_file=go/entity/version.go
sed -i.bak -E "s/^const Version = \"[^\"]+\"$/const Version = \"$new_version\"/" "$go_version_file" \
  && rm "$go_version_file.bak"
# The gin adapter is its own Go module and requires the root module by version; keep that pin
# in lockstep so the adapter tagged go/adapter/gin/vX.Y.Z resolves the root at the same vX.Y.Z.
gin_mod_file=go/adapter/gin/go.mod
sed -i.bak -E "s#^([[:space:]]*github.com/montionugera/node-server-decorator/v2 )v[0-9]+\\.[0-9]+\\.[0-9]+\$#\\1v$new_version#" "$gin_mod_file" \
  && rm "$gin_mod_file.bak"
# Mirror into the Nim package manifest (F-006) — nimble reads `version` from it and
# check-versions.sh asserts it. The capture group keeps the manifest's own spacing.
nimble_file=nim/server_decorator.nimble
sed -i.bak -E "s/^(version[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"$new_version\"/" "$nimble_file" \
  && rm "$nimble_file.bak"
# Mirror into the Rust workspace manifest
rust_cargo_file=rust/Cargo.toml
if [ -f "$rust_cargo_file" ]; then
  sed -i.bak -E "s/^(version[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"$new_version\"/" "$rust_cargo_file" \
    && rm "$rust_cargo_file.bak"
  # Internal crate deps in [workspace.dependencies] carry the same version next to their path
  # (crates.io rejects path-only deps), so move them in the same step.
  sed -i.bak -E "/^server-decorator-/s/(version[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"$new_version\"/" "$rust_cargo_file" \
    && rm "$rust_cargo_file.bak"
  # Cargo.lock records each workspace member's own version (like uv.lock below); refresh it.
  if command -v cargo >/dev/null 2>&1; then
    cargo update --manifest-path "$rust_cargo_file" --workspace
  fi
fi
# uv.lock pins each workspace member's own version (python/uv.lock's `[[package]]
# name = "server-decorator" version = "..."` entry) — refresh it so the lockfile doesn't
# go stale on every publish (unlike pnpm-lock, which doesn't record a workspace member's
# own version, uv.lock does).
if command -v uv >/dev/null 2>&1; then
  ( cd python && uv lock )
fi

bash scripts/check-versions.sh
echo "Bumped all packages to v$new_version"
echo "Next: git add -A && git commit -m \"chore: bump to v$new_version\" && git tag v$new_version && git push --tags"
