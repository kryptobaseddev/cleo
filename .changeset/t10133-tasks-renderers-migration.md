---
id: t10133-tasks-renderers-migration
tasks: [T10133]
kind: refactor
summary: "B8 decompose tasks.ts (371 LOC) into packages/core/src/render/tasks"
prs: [556]
---

Migrates `renderShow`/`renderList`/`renderTree`/`renderFind`/etc.
(371 LOC) from `packages/cleo/src/cli/renderers/tasks.ts` to
`packages/core/src/render/tasks/`. Each renderer self-registers into B5
registry on module load. Zero behavior change — snapshot tests pass
unchanged.
