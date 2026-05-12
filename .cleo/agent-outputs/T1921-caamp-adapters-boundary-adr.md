# T1921 — ADR-064: CAAMP↔Adapters Boundary

## Status: Complete (blocked on T1919 pending dep for cleo complete)

## Deliverables

### ADR created
- `docs/adr/ADR-064-caamp-adapters-boundary.md`
- Sequential number: ADR-064 (ADR-063 was previous)
- Status: Accepted | Date: 2026-05-06

### AGENTS.md files updated
- `packages/caamp/AGENTS.md` — added item 6 in Key Architectural Decisions linking ADR-064
- `packages/adapters/AGENTS.md` — created new file with boundary rules, anti-patterns, how-to-add-provider guide

### Commit
- SHA: `58df1a3d19bedb568dec173afae1a31a89e20791`
- Branch: `task/T1921`
- Message: `docs(T1921): ADR-064 — CAAMP↔adapters ownership boundary`

## ADR Ownership Matrix

| Concern | Owner |
|---------|-------|
| XDG/platform path resolution | `@cleocode/paths` (T1882 SSoT) |
| Provider registry | `@cleocode/caamp` (`providers/registry.json`) |
| Instruction-file injection engine | `@cleocode/caamp` (`inject()`, `ensureProviderInstructionFile()`) |
| Provider-specific runtime | `@cleocode/adapters` (thin adapters, consume CAAMP) |
| Bootstrap injection content | `@cleocode/cleo` config (`globalInjectionRefs` field, T1920) |

## Acceptance Criteria Check
- [x] ADR file created under `docs/adr/` with sequential number (ADR-064)
- [x] ADR explicitly states ownership matrix in a table
- [x] ADR cross-references T1882 (paths SSoT) + T1910 (epic)
- [x] ADR linked from `packages/caamp/AGENTS.md`
- [x] ADR linked from `packages/adapters/AGENTS.md` (new file created)
- [x] Markdown well-formed; no doc publish script failures

## Blocker Note
`cleo complete T1921` blocked by T1919 (status=pending). T1919's work
is already merged (commit c9649cee0 Merge task/T9017). Orchestrator
should complete T1919 first, then T1921 will complete.
