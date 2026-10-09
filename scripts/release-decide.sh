#!/usr/bin/env bash
# Prints action=repair when HEAD is the bot's bump commit and its version has no tag on origin
# (a publish run died before tagging and nothing merged since). Otherwise action=release.
set -euo pipefail
action=release
if [ "$(git log -1 --format=%s)" = "chore: bump patch version [skip ci]" ]; then
  tag="v$(node -p "require('./node/packages/core/package.json').version")"
  rc=0; git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || rc=$?
  case "$rc" in
    0) ;;
    2) action=repair ;;
    *) echo "release-decide: git ls-remote failed with status $rc" >&2; exit "$rc" ;;
  esac
fi
echo "action=$action"
