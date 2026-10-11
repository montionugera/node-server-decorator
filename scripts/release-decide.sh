#!/usr/bin/env bash
# Prints exactly one action for the publish job:
#   repair  HEAD is the bot's bump commit and its version has no tag on origin (a publish run died
#           before tagging and nothing merged since).
#   none    nothing but .claude/** and .release.json changed since the last v* tag reachable from HEAD
#           (zero changes included): release bookkeeping or a manual re-run on an already released
#           commit. Bumping would publish a new version with no code change.
#   release otherwise.
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
if [ "$action" = release ] && last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null); then
  changed=$(git diff --name-only "$last" HEAD)  # a git failure aborts here (set -e), never reads as "nothing changed"
  # grep -v exits 1 when every path is filtered out, which is exactly the "nothing real changed" case.
  if ! printf '%s\n' "$changed" | grep -qv -e '^\.claude/' -e '^\.release\.json$' -e '^$'; then action=none; fi
fi
echo "action=$action"
