#!/usr/bin/env bash
# Usage: release-notes.sh <previous tag> [<end ref>, default HEAD]
# Prints "- <commit title>" for each commit in the range, oldest first, minus the bot's bump commits.
set -euo pipefail
prev="${1:?usage: release-notes.sh <previous tag> [<end ref>]}"
log=$(git log "$prev..${2:-HEAD}" --no-merges --reverse --format='- %s')
notes=$(printf '%s\n' "$log" | grep -v '^- chore: bump patch version' | grep . || true)
printf '%s\n' "${notes:-- Maintenance release}"
