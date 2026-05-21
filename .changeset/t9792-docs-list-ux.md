---
id: t9792-docs-list-ux
tasks: [T9792]
kind: feature
summary: cleo docs list defaults to project scope, supports --limit + --orderBy, and surfaces a narrowing hint.
---

`cleo docs list` now works WITHOUT requiring an explicit scope flag.

- `cleo docs list --type adr` (no other scope) auto-promotes to project
  scope (was: `E_VALIDATION`). The dispatch envelope carries a one-line
  `hint` and lifts it into `meta.hint` so JSON consumers can detect that
  the default kicked in via `--field meta.hint`.
- `cleo docs list` (no args) returns the project-wide listing plus the
  same narrowing hint pointing operators at `--task`, `--session`, or
  `--observation` for tighter queries.
- `--task / --session / --observation / --project` mutual exclusivity is
  preserved — the CLI still rejects ambiguous combinations with
  `E_VALIDATION`.
- New `--limit <N>` (default 50, `<=0` for unlimited) truncates the
  result set, with the response carrying `totalCount` + a hint when
  truncation kicked in.
- New `--orderBy <newest|sha|slug>` (default `newest`) controls the row
  ordering — slug-less rows sort last under `slug`.

Contracts: `DocsListParams` gains optional `limit` + `orderBy`;
`DocsListResult` gains `totalCount`, `limit`, `orderBy`, and `hint`.
The `DOCS_LIST_DEFAULT_LIMIT` constant + `DocsListOrderBy` union are
exported from `@cleocode/contracts/operations/docs`.

Closes T9792. Saga SG-DOCS-CANON-CLOSURE (T9787).
