---
id: pre-push-ungated-visible
tasks: [T13774]
kind: fix
summary: "The managed pre-push hook now prints one clear WARNING line naming why a push went through without project checks, and flags a checkout whose hooks are activated"
---

When the pre-push hook could not run project checks, because `cleo` was not on
PATH, the `cleo` on PATH had no hooks-v1 runner, or the runner failed, it
allowed the push with a terse note that was easy to miss inside a harness.

It now prints `cleo pre-push: WARNING: push NOT gated by project hooks:
<reason>.`. When this checkout's activation is on, the line adds that project
hooks are ACTIVATED here but did not run. The push is still allowed, because
the spec keeps infrastructure faults non-blocking. Installed copies of the
previous template refresh on upgrade.
