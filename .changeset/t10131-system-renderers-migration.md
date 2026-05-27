---
id: t10131-system-renderers-migration
tasks: [T10131, T10147, T10148, T10149]
kind: refactor
summary: "B6 decompose system.ts (1302 LOC) into packages/core/src/render/{session,orchestration,brain}"
prs: [560]
---

Migrates all 22 renderers (1302 LOC) from
`packages/cleo/src/cli/renderers/system.ts` to
`packages/core/src/render/` organized by family. Each renderer
self-registers into the B5 registry on module load. Dispatcher in
`packages/cleo/src/cli/renderers/index.ts` shrinks to a thin shell.
Zero behavior change — snapshot tests pass unchanged.

Subtasks: T10147 (session), T10148 (orchestration), T10149 (brain).
