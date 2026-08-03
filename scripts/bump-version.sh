#!/usr/bin/env bash
# Bump ALL packages in lock-step (Decision #2, ADR 0006). Usage: scripts/bump-version.sh patch|minor|major
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
# gen_pydantic pins its intra-repo dependency on server-decorator-entity EXACTLY (I-f) — mirrors
# how `pnpm publish` rewrites Node's `workspace:*` to an exact version for the published wheel's
# Requires-Dist metadata (uv's `[tool.uv.sources] ... workspace = true` is dev-time-only and
# contributes nothing to the built wheel). Rewrite the pin here so it never goes stale on a bump.
sed -i.bak -E "s/(\"server-decorator-entity)==[0-9]+\.[0-9]+\.[0-9]+(\")/\1==$new_version\2/" \
  python/packages/gen_pydantic/pyproject.toml && rm python/packages/gen_pydantic/pyproject.toml.bak
# Mirror into each package's runtime __version__ export (what `server_decorator.__version__`
# actually reads at import time) — pyproject.toml alone is invisible to consumers.
for v in python/packages/*/src/*/_version.py; do
  sed -i.bak "s/^__version__ = .*/__version__ = \"$new_version\"/" "$v" && rm "$v.bak"
done
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
