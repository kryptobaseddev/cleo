---
id: pre-push-ungated-visible
tasks: [T13774]
kind: fix
summary: "The managed pre-push hook now prints one clear WARNING line naming why a push went through without project checks, and flags a checkout whose hooks are activated"
---

When the pre-push hook could not run project checks, it could allow the push
with no message at all. Inside Codex, `zsh -lc` put mise's stable `cleo` 10.16
first on PATH. That build answers the runner probe but keeps hooks-v1 inert, so
`git push` printed only "[new branch]".

The hook now asks `cleo hook run --probe -- execution`, which new builds answer
with `CLEO_PROJECT_HOOK_EXEC` or `CLEO_PROJECT_HOOK_INERT`. Older builds still
answer `CLEO_PROJECT_HOOK_V1`; for those, a stable version before 2026.10.17 is
treated as inert. Every ungated outcome now prints one line:
`cleo pre-push: WARNING: push NOT gated by project hooks: <reason>.` The reasons
are: cleo is not on PATH, cleo <version> at <path> runs no project hooks or has
no runner, or the runner failed. When this checkout's activation is on, the
line adds that project hooks are ACTIVATED here but did not run. The push is
still allowed, because the spec keeps infrastructure faults non-blocking.
Installed copies of the previous template refresh on upgrade.
