# T5717 — P1: Create packages/core/README.md + promote CORE-PACKAGE-SPEC + resolve dead import

**Task**: T5717
**Epic**: T5716
**Date**: 2026-03-17
**Status**: complete

---

## Summary

Three deliverables completed: README.md created for `@cleocode/core`, CORE-PACKAGE-SPEC.md promoted from DRAFT to APPROVED, and a dead commented-out import removed from `validator.ts`. `npx tsc --noEmit` passes with zero errors.

## Content

### Deliverable 1: packages/core/README.md

Created at `/mnt/projects/claude-todo/packages/core/README.md`.

Covers:
- What `@cleocode/core` is (extracted business logic kernel)
- Install instruction (`npm install @cleocode/core`)
- All three consumer patterns with accurate, code-derived examples
- Full API Surface table for all 7 domains: tasks (8 methods), sessions (16 methods), memory (6 methods), orchestration (8 methods), lifecycle (10 methods + stages array), release (7 methods), admin (2 methods)
- Architecture diagram showing how this package sits within `@cleocode/cleo`
- Requirements (Node >= 24, ESM) and License (MIT)

All API signatures were taken directly from `packages/core/src/cleo.ts` interfaces (`TasksAPI`, `SessionsAPI`, `MemoryAPI`, `OrchestrationAPI`, `LifecycleAPI`, `ReleaseAPI`, `AdminAPI`) and `packages/core/src/index.ts` tree-shakeable exports.

### Deliverable 2: docs/specs/CORE-PACKAGE-SPEC.md

Changed `**Status**: DRAFT` to `**Status**: APPROVED`. No other modifications.

### Deliverable 3: Dead import removal

`src/core/skills/orchestrator/validator.ts` lines 23-24 contained:

```typescript
// validateReturnMessage used for protocol validation in validate_return_message
// import { validateReturnMessage } from '../validation.js';
```

Investigation: `validateReturnMessage` exists in `src/core/skills/validation.ts` at line 187. However, the function is not called anywhere in `validator.ts` — there is no `validate_return_message` function in the file, and the comment was stale dead code from an uncommitted design idea. The entire two-line comment block was removed. `validateReturnMessage` remains available via its own module for other consumers.

### Verification

`npx tsc --noEmit` — exited cleanly, zero output, zero errors.

## References

- Task: T5717
- Epic: T5716
- Files modified:
  - `packages/core/README.md` (created)
  - `docs/specs/CORE-PACKAGE-SPEC.md` (status: DRAFT → APPROVED)
  - `src/core/skills/orchestrator/validator.ts` (removed dead comment block)
