---
id: t13527-pnpm-symlink-snapshot
tasks: [T13527]
kind: fix
summary: "typed gates that run a script through pnpm's node_modules link no longer fail verify, and a gate whose inputs cannot be captured fails alone instead of aborting every gate"
---

A typed test gate that resolved to `node node_modules/vitest/vitest.mjs` died
with "Typed input has an ambiguous symlink parent". pnpm links
`node_modules/<pkg>` into its `node_modules/.pnpm/…` virtual store, and the
input snapshot refused any symlinked parent. Because the first snapshot ran
outside the per-gate error handling, one such gate aborted the whole
`cleo verify` with `E_GENERAL`.

- An interpreter script reached through a `node_modules` link that resolves
  into this project's `.pnpm` virtual store is captured at its real path. Any
  other symlinked parent is still refused.
- A gate whose inputs cannot be captured (a redirected parent, an escaping
  path, an oversized input) is recorded as that gate's own unmet `error` and
  never executed; the other gates still run. A cancellation still aborts the
  run.
