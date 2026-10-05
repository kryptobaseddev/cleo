---
id: t13126-lazy-tasks-domain
tasks: [T13126]
kind: fix
summary: cleo show, find, list and current load about 450 modules and ~135 MB instead of ~820 and ~190 MB
---

The read verbs paid for code they never run:

- **Tasks domain handlers load per operation.** The tasks dispatch domain imported every task
  operation's implementation up front (add, update, sagas, lifecycle, sync, analysis, …). Each
  handler now loads its implementation on first call, so `cleo show` loads only what `show` needs.
- **The token-usage recorder loads only for mutations.** It records mutations only, but its
  provider detection imported all of CAAMP for every command.
- **`--describe` loads the operation describer only when asked.** Deriving output contracts
  loads the zod workgraph schemas.
- **`cleo current` reads through a leaf** (`task-work/current.ts`, `session/task-current.ts`)
  instead of the session engine, which loads the sessions barrel and registers hook handlers.

Output is unchanged: 38 commands compared byte for byte (stdout, stderr, exit code), human
output included. Gate 39 lowers `show`, `find`, `current` to 500 modules, `list --human` to
565, and adds `cleo current` and `list --describe` probes (the describer loads through
`require(esm)`, so top-level await in its graph fails the gate). Gate 38 follows lazily loaded
handler bindings (`const x = lazy(async () => (await import(s)).name)`), so moving a mutate
handler behind a lazy loader keeps its write path covered.
