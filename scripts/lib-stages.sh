#!/usr/bin/env bash
# Sourced by scripts/precheck.sh and scripts/integration.sh. A failing stage never aborts the run:
# every stage executes, `finish` prints one summary line and returns non-zero if any stage failed.
# A stage's output is shown only on failure (last 25 lines), so a green run stays short.
FAILED=(); SKIPPED=(); PASSED=0; _START=$SECONDS
stage(){ # name command...
  local name=$1 s=$SECONDS out rc=0; shift
  out=$("$@" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then PASSED=$((PASSED + 1)); echo "ok   $name ($((SECONDS - s))s)"
  else FAILED+=("$name"); echo "FAIL $name ($((SECONDS - s))s, exit $rc)"; printf '%s\n' "$out" | tail -n 25; fi
}
skip(){ SKIPPED+=("$1: $2"); echo "skip $1 ($2)"; }
finish(){ # label
  local line="$1: $PASSED passed, ${#FAILED[@]} failed" i sep
  if [ "${#FAILED[@]}" -gt 0 ]; then sep=""; line+=" ("; for i in "${FAILED[@]}"; do line+="$sep$i"; sep=", "; done; line+=")"; fi
  line+=", ${#SKIPPED[@]} skipped"
  if [ "${#SKIPPED[@]}" -gt 0 ]; then sep=""; line+=" ("; for i in "${SKIPPED[@]}"; do line+="$sep$i"; sep="; "; done; line+=")"; fi
  echo "$line in $((SECONDS - _START))s"
  [ "${#FAILED[@]}" -eq 0 ]
}
