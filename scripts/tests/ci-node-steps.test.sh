#!/usr/bin/env bash
# Run: bash scripts/tests/ci-node-steps.test.sh   (npm, pnpm and gh are stubs that only log; nothing is published)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"; WF="$R/.github/workflows/ci-node.yml"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1: got '$2', want '$3'"; fail=1; fi; }
run_of(){ ruby -ryaml -e 's=YAML.load_file(ARGV[0])["jobs"][ARGV[1]]["steps"].find{|x|x["name"]==ARGV[2]} or abort "no step: #{ARGV[2]}"; puts s["run"]' "$WF" "$1" "$2"; }
command -v ruby >/dev/null || { echo "FAIL - this test needs ruby (CI runs it via ci-scripts.yml; ruby is preinstalled on ubuntu runners)"; exit 1; }
# GitHub runs a step that has no `shell:` key as `bash -e` WITHOUT pipefail; run the bodies the same way.
step(){ bash -e -c "$(run_of "$1" "$2")"; }
export LOG="$T/log" RUNNER_TEMP="$T/rt" GITHUB_OUTPUT="$T/out"; : > "$LOG"; mkdir -p "$T/bin" "$RUNNER_TEMP"
printf '#!/bin/sh\necho "npm $*" >> "$LOG"\n[ "$1" = view ] && [ "$2" = "@x/a@1.0.0" ] && echo 1.0.0\nexit 0\n' > "$T/bin/npm"
printf '#!/bin/sh\nmkdir -p .t/package && cp package.json .t/package/ && tar -czf "$3/$(basename "$PWD").tgz" -C .t package && rm -rf .t\n' > "$T/bin/pnpm"
printf '#!/bin/sh\necho "gh $*" >> "$LOG"\n[ "$1 $2" = "release view" ] && exit "${GH_VIEW_RC:-1}"\nexit 0\n' > "$T/bin/gh"
chmod +x "$T/bin"/*; export PATH="$T/bin:$PATH"
mk(){ git init -q "$1"; cd "$1" || exit 1; git config user.email t@t; git config user.name t; git config commit.gpgsign false; }
mk "$T/w"; cp -R "$R/scripts" .; mkdir -p node/packages/core; echo '{"version":"9.9.10"}' > node/packages/core/package.json
printf '# Changelog\n\n## 9.9.9 - 2026-01-01\n\n- old: thing (#1)\n' > CHANGELOG.md; git add -A; git commit -qm 'feat: base'; git tag v9.9.9; echo x > feature.txt; git add -A; git commit -qm 'feat: thing (#7)'
: > "$GITHUB_OUTPUT"; step publish 'Decide release or repair' >/dev/null; rc=$?
check "decide: writes the action to the step output" "$rc:$(cat "$GITHUB_OUTPUT")" "0:action=release"
step publish 'Write CHANGELOG entry' >/dev/null
check "changelog: header kept, entry at line 3, notes at line 5" "$(sed -n '1p;3p;5p' CHANGELOG.md)" "$(printf '# Changelog\n## 9.9.10 - %s\n- feat: thing (#7)' "$(date -u +%F)")"
export TAG=v9.9.10 ASSET=docs-site.tgz; : > docs-site.tgz
GH_VIEW_RC=1 step release 'Create GitHub Release' >/dev/null
check "release: creates with verified tag, notes file and asset" "$(grep -c '^gh release create v9.9.10 --verify-tag --title v9.9.10 --notes-file notes.md docs-site.tgz$' "$LOG")" "1"
check "release: notes come from that version's section" "$(grep -c '^- ' notes.md):$(grep -c 'feat: thing (#7)' notes.md)" "1:1"
GH_VIEW_RC=0 step release 'Create GitHub Release' >/dev/null
check "release: existing release gets the asset re-uploaded, not re-created" "$(grep -c '^gh release upload v9.9.10 docs-site.tgz --clobber$' "$LOG"):$(grep -c '^gh release create' "$LOG")" "1:1"
: > "$LOG"; out=$(ASSET="" GH_VIEW_RC=1 step release 'Create GitHub Release')
check "release: without the archive it still creates the release, and warns" "$(grep -c '^gh release create v9.9.10 --verify-tag --title v9.9.10 --notes-file notes.md$' "$LOG"):$(echo "$out" | grep -c '::warning::')" "1:1"
# Docs archive: the portal checks a root version.json against the release tag. Stub pnpm only makes website/dist.
mkdir -p "$T/dbin"; printf '#!/bin/sh\n[ "$1" = build ] && mkdir -p dist && echo "<html></html>" > dist/index.html\nexit 0\n' > "$T/dbin/pnpm"; chmod +x "$T/dbin/pnpm"
mkdir -p website; : > "$GITHUB_OUTPUT"; PATH="$T/dbin:$PATH" TAG=v9.9.10 step release 'Build docs archive' >/dev/null; mkdir -p "$T/x"; tar -xzf docs-site.tgz -C "$T/x"
check "docs archive: root version.json is exactly the tag version, no leading v" "$(cat "$T/x/version.json" 2>/dev/null)" '{"version":"9.9.10"}'
check "docs archive: site files stay at the archive root" "$(test -f "$T/x/index.html" && echo yes)" "yes"
out=$(GH_TOKEN="" step release 'Signal the developer portal')
check "portal: warns and sends nothing while the secret is unset" "$(echo "$out" | grep -c 'PORTAL_DISPATCH_TOKEN is not set'):$(grep -c 'workflow run' "$LOG")" "1:0"
git tag -d v9.9.9 >/dev/null; out=$(step publish 'Write CHANGELOG entry'); rc=$?
check "changelog: failure warns, writes placeholder, exits 0" "$rc:$(echo "$out" | grep -c '::warning::'):$(sed -n 5p CHANGELOG.md)" "0:1:- Release 9.9.10"
mk "$T/d"; cp -R "$R/scripts" .; mkdir -p node/packages/core; echo '{"version":"9.9.9"}' > node/packages/core/package.json
git add -A; git commit -qm 'chore: bump patch version [skip ci]'; git remote add origin "$T/missing.git"
: > "$GITHUB_OUTPUT"; step publish 'Decide release or repair' >/dev/null 2>&1; rc=$?
check "decide: a failing script fails the step and sets no action" "$([ "$rc" -ne 0 ] && echo nonzero):$(cat "$GITHUB_OUTPUT")" "nonzero:"
mk "$T/n"; for p in a b; do mkdir -p "packages/$p"; echo "{\"name\":\"@x/$p\",\"version\":\"1.0.0\"}" > "packages/$p/package.json"; done
git add -A; git commit -qm base; : > "$LOG"; step publish 'Publish Node to npmjs.com' >/dev/null; rc=$?
check "npmjs: publishes only the missing package" "$rc:$(grep -c '^npm publish' "$LOG"):$(grep -c '^npm publish .*/b.tgz' "$LOG")" "0:1:1"
# Hostile squash-merge titles are text: they must land in the entry byte-for-byte and never execute.
mk "$T/h"; printf '# Changelog\n' > CHANGELOG.md; mkdir -p node/packages/core; echo '{"version":"2.0.1"}' > node/packages/core/package.json; cp -R "$R/scripts" .
git add -A; git commit -qm base; git tag v2.0.0
H1='fix: say "hi" (#1)'; H2="fix: it's (#2)"; H3='fix: `touch PWNED` (#3)'; H4='fix: $(touch PWNED) (#4)'; H5='fix: $HOME and ${HOME} (#5)'
for m in "$H1" "$H2" "$H3" "$H4" "$H5"; do git commit -q --allow-empty -m "$m"; done
step publish 'Write CHANGELOG entry' >/dev/null 2>&1
check "hostile titles: entry holds all five subjects byte-for-byte" "$(sed -n '5,$p' CHANGELOG.md)" "$(printf -- '- %s\n' "$H1" "$H2" "$H3" "$H4" "$H5")"
check "hostile titles: nothing was executed (no PWNED file anywhere)" "$(find "$T" "$PWD" -name 'PWNED*' 2>/dev/null | wc -l | tr -d ' ')" "0"
# Prepending keeps every older entry intact and in order.
mk "$T/o"; mkdir -p node/packages/core; echo '{"version":"3.0.3"}' > node/packages/core/package.json; cp -R "$R/scripts" .
OLD=$'## 3.0.2 - 2026-02-02\n\n- b: two (#2)\n- b: three (#3)\n\n## 3.0.1 - 2026-01-01\n\n- a: one (#1)'
printf '# Changelog\n\n%s\n' "$OLD" > CHANGELOG.md; git add -A; git commit -qm base; git tag v3.0.2; git commit -q --allow-empty -m 'feat: new (#9)'
step publish 'Write CHANGELOG entry' >/dev/null 2>&1
check "changelog: older entries intact and in order after the new one" "$(tail -n +7 CHANGELOG.md)" "$OLD"
check "changelog: new entry sits between the header and the older entries" "$(sed -n '1,6p' CHANGELOG.md)" "$(printf '# Changelog\n\n## 3.0.3 - %s\n\n- feat: new (#9)\n' "$(date -u +%F)")"
# npmjs guard when the registry lookup fails: the guard must not match, so the publish is attempted.
mkdir "$T/bin2"; printf '#!/bin/sh\necho "npm $*" >> "$LOG"\n[ "$1" = view ] && exit 1\nexit 0\n' > "$T/bin2/npm"; chmod +x "$T/bin2/npm"
cd "$T/n" || exit 1; : > "$LOG"; PATH="$T/bin2:$PATH" step publish 'Publish Node to npmjs.com' >/dev/null 2>&1; rc=$?
check "npmjs: failed registry lookup does not skip, both packages are published" "$rc:$(grep -c '^npm publish' "$LOG")" "0:2"
# skip-existing is true only for a repair run (evaluates the YAML expression, simple == comparisons only).
skip_for(){ ruby -ryaml -e 's=YAML.load_file(ARGV[0])["jobs"]["publish"]["steps"].find{|x|x["uses"].to_s.start_with?("pypa/gh-action-pypi-publish")} or abort "no pypi step"; e=s["with"]["skip-existing"][/\$\{\{(.*)\}\}/,1] or abort "no expr"; puts eval(e.sub("steps.decide.outputs.action", ARGV[1].inspect))' "$WF" "$1"; }
check "skip-existing: true for repair" "$(skip_for repair)" "true"
check "skip-existing: false for release" "$(skip_for release)" "false"
check "skip-existing: false when the action is empty" "$(skip_for '')" "false"
# action=none must reach no step that bumps, builds, publishes or tags, and must skip the smoke and release jobs.
ungated=$(ruby -ryaml -e 'j=YAML.load_file(ARGV[0])["jobs"]; seen=false; bad=[]; j["publish"]["steps"].each{|s| seen||=(s["id"]=="decide"); next unless seen; next if s["id"]=="decide"; c=s["if"].to_s; bad<<(s["name"]||s["uses"]) unless c =~ /steps\.decide\.outputs\.action (!= |== )."(none|release)"?/ || c =~ /steps\.decide\.outputs\.action (!=|==) .(none|release)./}; puts bad.join(",")' "$WF")
check "none: every publish step after decide is conditioned on the decided action" "$ungated" ""
check "none: the publish job exports the action" "$(ruby -ryaml -e 'puts YAML.load_file(ARGV[0])["jobs"]["publish"]["outputs"]["action"]' "$WF")" '${{ steps.decide.outputs.action }}'
check "none: smoke and release jobs are skipped" "$(ruby -ryaml -e 'j=YAML.load_file(ARGV[0])["jobs"]; puts %w[smoke release].map{|n| j[n]["if"]}.join("|")' "$WF")" "needs.publish.outputs.action != 'none'|needs.publish.outputs.action != 'none'"
check "none: nothing runs before decide except checkout and git config" "$(ruby -ryaml -e 'st=YAML.load_file(ARGV[0])["jobs"]["publish"]["steps"]; puts st.take_while{|s| s["id"]!="decide"}.map{|s| s["name"]||s["uses"]}.join("|")' "$WF")" "actions/checkout@v7|Configure git"
# Concurrency: main runs are never cancelled mid-flight (publish then release); PR runs still cancel superseded runs.
cip=$(ruby -ryaml -e 'puts YAML.load_file(ARGV[0])["concurrency"]["cancel-in-progress"]' "$WF")
check "concurrency: cancel-in-progress is false on main, true elsewhere" "$cip" "\${{ github.ref != 'refs/heads/main' }}"
exit "$fail"
