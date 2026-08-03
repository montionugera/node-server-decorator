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

bash scripts/check-versions.sh
echo "Bumped all packages to v$new_version"
echo "Next: git add -A && git commit -m \"chore: bump to v$new_version\" && git tag v$new_version && git push --tags"
