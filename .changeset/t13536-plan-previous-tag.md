---
id: t13536-plan-previous-tag
tasks: [T13536]
kind: fix
summary: "cleo release plan records the newest reachable v* tag as previousTag/previousVersion, not a stale releases-table row"
---
The plans for v2026.10.6, 10.7 and 10.8 all recorded `previousVersion` and `previousTag` as v2026.10.4, because the releases table lagged the tags: those releases were not yet reconciled. Each plan had to be hand-edited.

`cleo release plan` now takes both fields from the newest `v*` tag reachable from HEAD (`git tag --merged HEAD`, ordered by version, excluding the version being planned). On the `latest` channel, prerelease tags are skipped. This matches the tag that release-prepare's `git describe --tags --abbrev=0` resolves, and it settles ties on one commit by the higher version. `previousShippedAt` comes from the releases row only when that row is the same version. Without a reachable tag, plan falls back to the releases table, as before.
