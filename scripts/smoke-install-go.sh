#!/usr/bin/env bash
# Post-tag smoke test (F-007): a fresh consumer module can resolve and build go/entity at <tag>.
# go/entity is a library, so this builds an importing module rather than `go install`-ing it.
# Usage: scripts/smoke-install-go.sh <tag>        e.g. v2.0.5
set -euo pipefail

tag="${1:?usage: smoke-install-go.sh <tag>}"
module="github.com/montionugera/node-server-decorator/v2"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Scratch caches so a warm local cache can't mask a broken tag; -modcacherw lets rm -rf clean up.
export GOPATH="$work/gopath" GOMODCACHE="$work/modcache" GOFLAGS=-modcacherw
# Straight from the git tag: no public-proxy indexing lag, and the repo is private.
export GOPROXY=direct GOSUMDB=off GOPRIVATE="github.com/montionugera/*"

mkdir "$work/consumer"
cd "$work/consumer"
go mod init example.com/smoke >/dev/null 2>&1
cat > main.go <<EOF
package main

import _ "$module/go/entity"

func main() {}
EOF

go get "$module@$tag"
go build ./...
echo "OK: $module/go/entity@$tag resolves and builds"
