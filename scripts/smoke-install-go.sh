#!/usr/bin/env bash
# Post-tag smoke test (F-007): a fresh consumer module can resolve and build go/entity at <tag>,
# plus the nested adapter modules go/adapter/gin and go/adapter/pgxlock at their lock-step tags
# (go/adapter/<name>/<tag>). These are libraries, so this builds an importing module rather
# than `go install`-ing them.
# Two passes: straight from the git tag (proves the tags are right, no proxy lag), then through
# the public proxy and checksum database with no credentials (proves an anonymous client can
# install). The second pass retries, because the proxy can lag right after a tag is pushed.
# Usage: scripts/smoke-install-go.sh <tag>        e.g. v2.0.5
#   SMOKE_PUBLIC_ATTEMPTS (default 10) / SMOKE_PUBLIC_DELAY seconds (default 30) bound the retry.
set -euo pipefail

tag="${1:?usage: smoke-install-go.sh <tag>}"
module="github.com/montionugera/node-server-decorator/v2"
gin_module="github.com/montionugera/node-server-decorator/go/adapter/gin/v2"
pgxlock_module="github.com/montionugera/node-server-decorator/go/adapter/pgxlock/v2"
public_attempts="${SMOKE_PUBLIC_ATTEMPTS:-10}"
public_delay="${SMOKE_PUBLIC_DELAY:-30}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# install_pass <name>: resolve and build all three modules in a fresh consumer module, with
# scratch caches so a warm cache (local, or the other pass's) can't mask a broken tag;
# -modcacherw lets rm -rf clean up. The caller sets GOPROXY/GOSUMDB/GOPRIVATE.
install_pass() {
  local dir="$work/$1"
  rm -rf "$dir"
  mkdir -p "$dir/consumer"
  (
    export GOPATH="$dir/gopath" GOMODCACHE="$dir/modcache" GOFLAGS=-modcacherw
    cd "$dir/consumer"
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
    # `&&`, not errexit: bash ignores `set -e` while this runs as the retry loop's condition.
    go get "$module@$tag" "$gin_module@$tag" "$pgxlock_module@$tag" && go build ./...
  )
}

# Pass 1: this repo's modules come straight from the git tag (GOPRIVATE bypasses the proxy and
# the checksum database), so there is no public-proxy indexing lag. The proxy serves only the
# adapters' third-party dependencies (gin, pgx).
GOPROXY=https://proxy.golang.org,direct GOSUMDB=off GOPRIVATE="github.com/montionugera/*" \
  install_pass direct
echo "OK: $module/go/entity, $gin_module and $pgxlock_module resolve and build at $tag (git tag)"

# Pass 2: the way an anonymous client installs. Proxy only (no `,direct`, so it cannot fall back
# to a credentialed git fetch), the default checksum database, no private-module exemptions, and
# no git or Go user config (GOENV=off ignores `go env -w` settings; the GIT_CONFIG_* values
# drop any URL rewrite, including the token rewrite the CI job passes in its step env).
attempt=1
until GOENV=off GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
  GOPRIVATE='' GONOPROXY='' GONOSUMDB='' GONOSUMCHECK='' GOINSECURE='' \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=0 \
  install_pass public; do
  if [ "$attempt" -ge "$public_attempts" ]; then
    echo "FAIL: $tag did not install through proxy.golang.org after $attempt attempts" >&2
    exit 1
  fi
  echo "Public proxy attempt $attempt/$public_attempts failed; retrying in ${public_delay}s."
  attempt=$((attempt + 1))
  sleep "$public_delay"
done
echo "OK: $module/go/entity, $gin_module and $pgxlock_module resolve and build at $tag (public proxy, anonymous)"
