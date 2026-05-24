---
id: t10498-spawn-bundling-fix
tasks: [T10498]
kind: fix
summary: cleo orchestrate spawn no longer throws Dynamic require of node:path
---

`runLintChangesets()` in `packages/core/src/orchestrate/spawn-ops.ts` was using
`const { join } = require('node:path')` and the equivalent for `node:fs`. The
ESM bundle helper rejects runtime `require()` calls it cannot statically resolve,
so every `cleo orchestrate spawn <Tid>` returned `E_GENERAL: Dynamic require of
"node:path" is not supported` and blocked every worker dispatch.

Converts both to static imports at file top. Also cleans up two stale changeset
entries that had been blocking the T10448 changeset-hygiene gate downstream of
the spawn fix:

- `.changeset/T10108.md` was a duplicate of `t10108-find-parent-filter.md` with
  a mismatched id field.
- `.changeset/T10485.md` used the legacy `"@cleocode/core": patch` frontmatter
  shape and failed the current schema (missing `id`, `tasks`, `kind`, `summary`).
  Re-filed under the canonical filename `t10485-remove-orphan-fn.md`.

Closes T10498. Saga: T10377. Decision: D013.
