#!/usr/bin/env bash
# For a run whose decision was `none` because HEAD is already inside a v* tag: prints tag=<vX> when that
# tag has no GitHub Release carrying docs-site.tgz (the release job died after publish tagged it and the
# run was repeated with "Re-run all jobs"). Prints nothing when the Release is complete or HEAD is in no tag.
# Needs GH_TOKEN. Fails on any gh error other than "release not found", so an outage never reads as complete.
set -euo pipefail
tag=$(git tag --contains HEAD --list 'v[0-9]*' | sort -V | sed -n 1p)  # the release that first shipped this commit
[ -n "$tag" ] || exit 0
if assets=$(gh release view "$tag" --json assets --jq '.assets[].name' 2>&1); then
  if printf '%s\n' "$assets" | grep -qx 'docs-site.tgz'; then exit 0; fi
elif [[ "$assets" != *"release not found"* ]]; then
  echo "::error::could not read the GitHub Release for $tag: $assets" >&2
  exit 1
fi
echo "::warning::Tag $tag has no GitHub Release with docs-site.tgz; the release job will create it. Packages are not re-published." >&2
echo "tag=$tag"
