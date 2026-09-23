---
id: cli-startup-barrel
tasks: [T12138]
kind: fix
summary: one barrel import cost ~1.2s on every CLI invocation — narrowed, and gated so it cannot come back (gh#1207)
---

`cleo --version` costs 1.31s against a 0.01s bare Node boot. Importing
`@cleocode/core/internal` — resolved exactly as the installed CLI resolves it —
accounts for 1.14s of that, roughly 87% of CLI startup, and it was reached,
transitively, for ONE function:
`buildCommandGroups`, imported by `help-renderer.ts`, which `index.ts` loads
eagerly on every invocation to build the alias map.

Every command paid it. `cleo --version`, `cleo --help`, and each of the 25
`cleo show` calls in the reporter's status sweep.

`index.ts` already carried a comment stating that `@cleocode/core/internal` is
a 2018-line barrel that must never be eagerly imported because it pulls in the
whole CORE dependency tree. The comment was correct and unenforced: the import
was added in a different file and nothing noticed.

Fixed by importing the narrow module instead: 0.09s against the barrel's
1.14s, both measured against the shipped 2026.8.9 core the CLI actually loads.
Core's `exports` map was missing
`./routing/*` and `./routing/*.js` entries that ~25 other directories already
have, so the narrow specifier did not resolve; both are added.

A new gate, `scripts/lint-cli-startup-barrel.mjs`, walks the CLI entrypoint's
STATIC import graph and fails on any CORE barrel import, naming the chain that
reaches it. Dynamic `await import(...)` at point of use remains fine — that is
the pattern the architecture prescribes. Per-line opt-out:
`// startup-barrel-allowed: <reason>`.

Note: the remaining floor is the bundle itself, not the process model.
Collapsing the double `node` spawn was measured separately and changed nothing
(1.33s before, 1.31s after).
