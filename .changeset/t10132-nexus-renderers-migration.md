---
id: t10132-nexus-renderers-migration
tasks: [T10132, T10150, T10151, T10152]
kind: refactor
summary: "B7 decompose nexus.ts (1055 LOC) into packages/core/src/render/nexus/{graph,contracts,audit}"
prs: [551]
---

Migrates 34 Nexus renderers (1055 LOC) from
`packages/cleo/src/cli/renderers/nexus.ts` to
`packages/core/src/render/nexus/`. Each renderer self-registers into the
B5 registry on module load. Zero behavior change — snapshot tests pass
unchanged.

Subtasks: T10150 (graph), T10151 (contracts), T10152 (audit).
