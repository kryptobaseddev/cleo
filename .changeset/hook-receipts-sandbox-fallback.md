---
id: hook-receipts-sandbox-fallback
tasks: [T13775]
kind: fix
summary: "Project hook receipts fall back to a self-ignoring .cleo/hook-receipts directory when the Git-private directory is read-only, as under Codex workspace-write"
---

Codex's workspace-write sandbox keeps `.git` read-only. The project hook runner
wrote its execution receipts only to Git's private `cleo-project-hooks`
directory, so every hooked call under the sandbox reported
`HOOK_RECEIPT_WRITE_FAILED` and left no receipt.

A receipt the Git-private directory refuses now goes to
`<checkout>/.cleo/hook-receipts/`, a directory with its own `.gitignore` of
`*`. The per-source/event slots are unchanged
(`last-execution-<source>-<sha256(event)>.json`), so a Git push never replaces
an agent receipt. Reads take the newer valid receipt from the two locations.
A fallback file that Git tracks or that is a symlink is never trusted. A
receipt that neither location accepts is still the visible
`HOOK_RECEIPT_WRITE_FAILED` fault.
