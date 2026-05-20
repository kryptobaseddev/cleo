---
id: t9766-contracts-wave1
tasks: [T9766]
kind: refactor
prs: [364]
summary: Centralize logger + memory studio-API types in @cleocode/contracts (Wave 1 of inline-types-in-core cleanup).
---

Wave 1 of moving cross-package types out of `@cleocode/core` and into `@cleocode/contracts` per the AGENTS.md SSoT rule — types that are imported across package boundaries (studio, cleo, caamp) live in contracts.

Moved (5 types, 2 new files in contracts):

- `LoggerConfig` → `@cleocode/contracts/src/logger.ts`
- `MemorySearchHit`, `MemoryGraphStats`, `MemoryDecisionRecord`, `PatternRecord`, `LearningRecord` → `@cleocode/contracts/src/memory.ts`

`@cleocode/core` re-exports the same names for back-compat — no breaking imports. Studio + cleo + caamp can now import from `@cleocode/contracts` directly, which is verified by 6 consumer-side import rewrites in this PR.

Resolved a name collision: `DecisionRecord` already existed in `@cleocode/contracts/operations/session.ts` as a session-ops audit-log shape (different fields). The memory-domain v2 type is therefore exported as `MemoryDecisionRecord`; `@cleocode/core/memory/public-api.ts` re-exports it under the legacy `DecisionRecord` name so existing callers stay green.
