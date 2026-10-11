---
title: "Pass the released tag to the developer portal signal as decorator_docs_tag"
id: F-036
status: refined
from_idea: I-041
---

# Portal signal carries the tag it just released

## Problem

The release job's last step dispatches `ci.yml` in montionugera/joy-design with no inputs, so the portal
pulls "latest", which can race a newer release. The portal workflow now accepts a `workflow_dispatch`
input `decorator_docs_tag` (a release tag such as `v2.0.27`; blank means latest).

## Sketch

In "Signal the developer portal": `TAG` is already a job env; the step runs
`gh workflow run ci.yml -R montionugera/joy-design --ref main -f decorator_docs_tag="$TAG"`, only when the
GitHub release for that tag exists and carries `docs-site.tgz` (checked with `gh release view "$TAG" --json assets`,
using the job token, not the portal token). No `${{ }}` inside `run:`. The missing-secret warning stays.

## Acceptance criteria

- [ ] with the secret set and the release holding docs-site.tgz, the dispatch carries `-f decorator_docs_tag=<tag>`
- [ ] with the secret unset: the warning, no dispatch (unchanged)
- [ ] release missing or without the archive: warning, no dispatch
- [ ] the step contains no `${{` inside `run:`
