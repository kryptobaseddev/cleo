# T5722: Update Remaining Canon Docs + CLEO-CANON-INDEX

**Task**: T5722
**Epic**: T5716
**Date**: 2026-03-18
**Status**: complete

---

## Summary

Updated four canon concept documents to accurately reflect the `@cleocode/core` standalone package architecture completed in Epic T5701. All changes are documentation-only — no source files were modified. Bidirectional cross-references to `docs/specs/CORE-PACKAGE-SPEC.md` were added in each updated document.

## Changes Made

### 1. docs/concepts/CLEO-VISION.md

- Rewrote the **Shared-Core Architecture** section to clarify that `src/core/` is published as `@cleocode/core` — a standalone npm package consumers can install without `@cleocode/cleo`.
- Added a **Package Boundary** ASCII diagram showing the `@cleocode/cleo` → `@cleocode/core` → `@cleocode/contracts` hierarchy with all three consumer patterns (Facade, tree-shaking, custom store).
- Added explicit statement that the four canonical systems (BRAIN, LOOM, NEXUS, LAFS) are implemented as domain modules within `@cleocode/core`.
- Added `@cleocode/core standalone package` to the **Shipped** inventory in the BRAIN Current State section.
- Added a "Specification" pointer to `docs/specs/CORE-PACKAGE-SPEC.md`.

### 2. docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md

- Added new **Section 3: Package Boundary** with a full ASCII diagram showing the package split and consumer patterns.
- Renumbered all subsequent sections (old 3-12 → new 4-13) to maintain consistent sequential numbering.
- Added `docs/specs/CORE-PACKAGE-SPEC.md` to the References section.
- Updated version/date frontmatter to `2026.3.18` and added `T5722` to the task field.

### 3. docs/concepts/NEXUS-CORE-ASPECTS.md

- Appended a new **Workshop Concepts to @cleocode/core Module Mapping** section with a 15-row table.
- Each row maps a workshop vocabulary term (The Hearth, Living BRAIN, The Loom, Threads, Tapestries/Cascade, The Proving, Tome, Cogs, The Sweep/Refinery, Nexus, Sticky Notes, Conduit, Watchers, Release, Admin) to its concrete `@cleocode/core` module path with a brief description.
- Added a **Standalone Access** note pointing to `docs/specs/CORE-PACKAGE-SPEC.md`.
- The narrative prose was not modified — additions appear after the concluding paragraph.

### 4. docs/concepts/CLEO-CANON-INDEX.md

- Added **entry 6** (`CORE-PACKAGE-SPEC.md`) to the Read Order list, inserted between the Atlas (5) and Manifesto (7). Old entries 6-10 renumbered to 7-11.
- Added `CORE-PACKAGE-SPEC.md` to the **Quick Purpose Map** section.
- Added `Core Package Spec` to the **One-Line Distinctions** section.
- Added a **Package note** to the LLM Note section clarifying the `@cleocode/core` vs `@cleocode/cleo` distinction with a direct link to the spec.

## Cross-Reference Check

| Document Updated | References Added To |
|-----------------|---------------------|
| CLEO-VISION.md | `docs/specs/CORE-PACKAGE-SPEC.md` |
| CLEO-SYSTEM-FLOW-ATLAS.md | `docs/specs/CORE-PACKAGE-SPEC.md` |
| NEXUS-CORE-ASPECTS.md | `docs/specs/CORE-PACKAGE-SPEC.md` |
| CLEO-CANON-INDEX.md | `docs/specs/CORE-PACKAGE-SPEC.md` |

`docs/specs/CORE-PACKAGE-SPEC.md` already references Epic T5701 and the relevant tasks. The AGENTS.md was updated in T5721 (prior task). No circular references introduced.

## Constraints Honored

- Story documents (CLEO-FOUNDING-STORY.md, CLEO-AWAKENING-STORY.md, CLEO-MANIFESTO.md) were not touched.
- CLEO-CONDUIT-PROTOCOL-SPEC.md was not touched (no wrong module paths found).
- NEXUS-CORE-ASPECTS.md narrative prose was preserved exactly — only an appendix section was added.
- Changes used clear language per the CLEO Documentation SOP; no RFC 2119 keywords added to concept docs.

## References

- Related tasks: T5716, T5721, T5701
- New spec: `docs/specs/CORE-PACKAGE-SPEC.md`
- Docs updated:
  - `/mnt/projects/claude-todo/docs/concepts/CLEO-VISION.md`
  - `/mnt/projects/claude-todo/docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`
  - `/mnt/projects/claude-todo/docs/concepts/NEXUS-CORE-ASPECTS.md`
  - `/mnt/projects/claude-todo/docs/concepts/CLEO-CANON-INDEX.md`
