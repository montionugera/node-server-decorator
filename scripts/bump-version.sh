#!/usr/bin/env bash
# Bump both packages in lock-step (Decision #2). Usage: scripts/bump-version.sh patch|minor|major
set -euo pipefail

bump=${1:?"usage: $0 patch|minor|major"}
case "$bump" in
  patch|minor|major) ;;
  *) echo "error: argument must be patch, minor, or major" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

# Bump Node first; npm version returns the new version on stdout.
( cd node && pnpm version "$bump" --no-git-tag-version >/dev/null )
new_version=$(node -p "require('./node/package.json').version")

# Mirror into Python (sed -i.bak for portability between BSD and GNU sed).
sed -i.bak "s/^version = .*/version = \"$new_version\"/" python/pyproject.toml
rm python/pyproject.toml.bak

# Sanity check: both files agree.
node_v=$(node -p "require('./node/package.json').version")
py_v=$(grep -oE '^version\s*=\s*"[^"]+"' python/pyproject.toml | grep -oE '"[^"]+"' | tr -d '"')
if [ "$node_v" != "$py_v" ]; then
  echo "FAIL: node $node_v != python $py_v after bump" >&2
  exit 1
fi

echo "Bumped both packages to v$new_version"
echo
echo "Next steps:"
echo "  git add node/package.json node/pnpm-lock.yaml python/pyproject.toml"
echo "  git commit -m \"chore: bump to v$new_version\""
echo "  git tag v$new_version"
echo "  git push && git push --tags  # this triggers publish-node.yml + publish-python.yml"
