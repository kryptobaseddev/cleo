---
"@cleocode/cleo": patch
"@cleocode/core": minor
---

refactor(T10132): decompose nexus.ts (1055 LOC) into packages/core/src/render/nexus/{graph,contracts,audit}/ (B7)

Migrates all 34 Nexus renderers from packages/cleo/src/cli/renderers/nexus.ts into packages/core/src/render/nexus/ organized by family. The cleo dispatcher now imports the renderers from @cleocode/core; the legacy file is deleted. Zero behavior change — every snapshot/assertion test passes unchanged.

Resolves AGENTS.md Package-Boundary Check violation (CLI commands package was hosting business logic that belongs in core).

Subtasks: T10150 (graph), T10151 (contracts), T10152 (audit).
Closes T10132. Epic: T10114. ADR: adr-077-human-render-contract.
