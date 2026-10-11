#!/usr/bin/env bash
# Post-tag smoke test (F-007): a fresh consumer module can resolve and build go/entity at <tag>,
# plus the nested adapter modules go/adapter/gin and go/adapter/pgxlock at their lock-step tags
# (go/adapter/<name>/<tag>). These are libraries, so this builds an importing module rather
# than `go install`-ing them.
# Usage: scripts/smoke-install-go.sh <tag>        e.g. v2.0.5
set -euo pipefail

tag="${1:?usage: smoke-install-go.sh <tag>}"
module="github.com/montionugera/node-server-decorator/v2"
gin_module="github.com/montionugera/node-server-decorator/go/adapter/gin/v2"
pgxlock_module="github.com/montionugera/node-server-decorator/go/adapter/pgxlock/v2"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Scratch caches so a warm local cache can't mask a broken tag; -modcacherw lets rm -rf clean up.
export GOPATH="$work/gopath" GOMODCACHE="$work/modcache" GOFLAGS=-modcacherw
# This repo's modules come straight from the git tag (GOPRIVATE bypasses the proxy): no
# public-proxy indexing lag, and the repo is private. The proxy serves only the adapters'
# third-party dependencies (gin, pgx).
export GOPROXY=https://proxy.golang.org,direct GOSUMDB=off GOPRIVATE="github.com/montionugera/*"

mkdir "$work/consumer"
cd "$work/consumer"
go mod init example.com/smoke >/dev/null 2>&1
cat > main.go <<EOF
package main

import (
	_ "$gin_module"
	_ "$pgxlock_module"
	_ "$module/go/entity"
)

func main() {}
EOF

go get "$module@$tag" "$gin_module@$tag" "$pgxlock_module@$tag"
go build ./...
echo "OK: $module/go/entity, $gin_module and $pgxlock_module resolve and build at $tag"
