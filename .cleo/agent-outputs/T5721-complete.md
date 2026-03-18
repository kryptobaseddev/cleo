# T5721 — P3-01: Update AGENTS.md + CLEO-OPERATION-CONSTITUTION.md

**Task**: T5721
**Epic**: T5716
**Date**: 2026-03-17
**Status**: complete

---

## Summary

Updated AGENTS.md and CLEO-OPERATION-CONSTITUTION.md to reflect the new @cleocode/core standalone package architecture. Both documents now accurately describe the two-tier package distribution (@cleocode/core vs @cleocode/cleo), consumer usage patterns, and the dispatch-vs-core boundary.

## Changes Made

### AGENTS.md (`/mnt/projects/claude-todo/AGENTS.md`)

1. **Architecture section heading** — Updated to reference `@cleocode/core` by name alongside `src/core/`.

2. **Package Distribution table** — New subsection added after the architecture diagram listing all five packages with npm install commands, purpose, and consumer profiles.

3. **Dependency Graph** — New code block showing the `@cleocode/cleo` → `@cleocode/core` dependency chain with all bundled dependencies.

4. **Two consumer profiles** — Added description of Consumer A (programmatic API) and Consumer B (custom store backend).

5. **Key Architecture Principles** — Added explicit note that `src/dispatch/` stays inside `@cleocode/cleo` and is NOT part of core. Clarified that `src/core/` is published as `@cleocode/core`.

6. **Project Structure** — Added `packages/core/` entry. Removed stale `packages/shared/` entry (deleted in v2026.3.34).

7. **Provider Adapter System** — Removed stale `packages/shared/` line.

8. **Key Files & Entry Points** — Added new "Consumer Usage Patterns" section with TypeScript examples for both `@cleocode/core` and `@cleocode/cleo`. Added @cleocode/core package entry points listing (`cleo.ts`, `index.ts`, `dist/index.js`). Renamed Core Business Logic heading to clarify `src/core/` = `@cleocode/core`. Removed stale `packages/shared/` from Provider Adapter Packages.

### CLEO-OPERATION-CONSTITUTION.md (`/mnt/projects/claude-todo/docs/specs/CLEO-OPERATION-CONSTITUTION.md`)

1. **Version/Date** — Updated to `2026.3.17` and task `T5721`.

2. **New Section 3: Operation Routing Architecture** — Inserted after Section 2 (Runtime Scope). Explains:
   - Dispatch vs Core separation and their distinct roles
   - The routing flow from MCP request through dispatch to @cleocode/core to SQLite
   - API style contrast between direct typed calls (core) vs string-addressed routing (dispatch)
   - Package boundary: why dispatch stays in @cleocode/cleo and is not part of @cleocode/core
   - ASCII diagram showing the full stack

3. **Section renumbering** — All original sections 3–16 renumbered to 4–17 to accommodate the new Section 3. Internal cross-references (Section 7 tables → Section 7, Section 9 → Section 8, Section 12 → Section 13) updated accordingly.

## Verification

- All changes are documentation-only (markdown files only)
- No broken internal links — section cross-references updated
- Architecture diagrams are consistent between AGENTS.md and Constitution
- Section numbering in Constitution is clean and sequential (1–17)
- Stale @cleocode/shared references removed (package was deleted in v2026.3.34)

## References

- Epic: T5716
- Task: T5721
- Related: T5702–T5715 (core extraction tasks)
- Files modified:
  - `/mnt/projects/claude-todo/AGENTS.md`
  - `/mnt/projects/claude-todo/docs/specs/CLEO-OPERATION-CONSTITUTION.md`
