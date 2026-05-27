---
id: t10129-format-helpers-migration
tasks: [T10129]
kind: refactor
summary: "B4 migrate format-helpers (kvBlock, dataTable, truncated) from packages/cleo to packages/core/render"
prs: [540]
---

Moves `kvBlock`, `dataTable`, `truncated` (and siblings) from
`packages/cleo/src/cli/renderers/format-helpers.ts` to
`packages/core/src/render/helpers.ts`. Adds a tiny internal
`packages/core/src/render/ansi.ts` (BOLD/DIM/NC) so the new module is
self-contained. Updates all callers; deletes the old file. Zero
behavior change — snapshot tests pass unchanged.

Resolves AGENTS.md Package-Boundary Check violation (rendering logic
belongs in `packages/core/`).
