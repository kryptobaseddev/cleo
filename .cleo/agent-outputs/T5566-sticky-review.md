# T5566 — sticky Domain Review

**Task**: T5566
**Date**: 2026-03-07
**Status**: complete

---

## Summary

Current: 6 ops | Target: ≤6 | Result: 6 ops (validated lean, no changes required)

The sticky domain handles ephemeral project-wide capture notes — a scratch-pad for quick ideas before formal classification as tasks, memories, or session context. All 6 operations are defensible.

---

## Operation Inventory

Sources verified:
- Registry: `src/dispatch/registry.ts` (lines 2793–2866)
- Handler: `src/dispatch/domains/sticky.ts`
- Engine: `src/dispatch/engines/sticky-engine.ts`
- Core: `src/core/sticky/` (8 source files, dedicated per-operation modules)

| Operation | Gateway | Tier | idempotent | sessionRequired | Required Params |
|-----------|---------|------|------------|-----------------|-----------------|
| `list`    | query   | 0    | true       | false           | none            |
| `show`    | query   | 0    | true       | false           | stickyId        |
| `add`     | mutate  | 0    | false      | false           | content         |
| `convert` | mutate  | 0    | false      | false           | stickyId, targetType |
| `archive` | mutate  | 0    | true       | false           | stickyId        |
| `purge`   | mutate  | 0    | true       | false           | stickyId        |

---

## Decision Matrix

| Operation | Used in agent workflows? | Tier correct? | Verb canonical? | Duplication risk? | Decision |
|-----------|--------------------------|--------------|-----------------|-------------------|----------|
| `list`    | Yes — discovery before acting on stickies | Tier 0 correct (no preconditions) | `list` is canonical | No overlap with other domains | KEEP |
| `show`    | Yes — inspect a single note before convert/archive | Tier 0 correct | `show` is canonical | No overlap | KEEP |
| `add`     | Yes — primary capture mechanism | Tier 0 correct (no session required by design) | `add` is canonical | No overlap | KEEP |
| `convert` | Yes — central lifecycle promotion; supports 4 target types (task, memory, task_note, session_note) via single op | Tier 0 correct | `convert` is acceptable domain verb (not in main VERB-STANDARDS but no canonical alternative exists) | Promotes to tasks/memory/session — no write duplication with those domains because sticky.convert handles the archiving of the source note atomically | KEEP |
| `archive` | Yes — soft-delete for processed notes | Tier 0 correct | `archive` is canonical for reversible removal | Distinct from `purge`; archive = soft, purge = hard | KEEP |
| `purge`   | Yes — hard-delete for unwanted captures | Tier 0 correct | `purge` is canonical for permanent deletion | Distinct from `archive` | KEEP |

---

## Challenge Questions Applied

### 1. Is any operation redundant with a task/memory/session operation?

No. `sticky.convert` is the only op that touches other domains, but it is the correct locus — the conversion responsibility belongs in the sticky domain (it owns the lifecycle of a sticky note including its promotion out of the domain). The receiving domain (tasks, memory) does not expose a "receive from sticky" operation, avoiding bidirectional coupling.

### 2. Should `archive` and `purge` be collapsed into one op?

No. Archive is idempotent soft-removal (status change, note remains queryable). Purge is permanent deletion. These are conceptually distinct and serve different agent use cases: archive when a note has been acted on but may be reviewed; purge when a note is noise. Collapsing them would require a `mode` parameter and lose the idempotency flag difference, which is tracked in the registry.

### 3. Is `purge` exercised in the test suite?

Yes. `src/core/sticky/__tests__/purge.test.ts` exists. The domain handler test (`sticky-list.test.ts`) mocks `stickyPurge`. The registry test (`sticky.test.ts`) does not explicitly assert `purge` registration — this is a minor gap but the registry entry itself is present and the handler implements the case.

### 4. Does `convert` accumulate too much complexity?

`convert` dispatches to four sub-paths (task, memory, task_note, session_note) via `targetType`. This is intentional consolidation. The alternative — four separate convert ops — would bloat the domain to 9 ops. The single `convert` with `targetType` is correct by KISS and aligns with how `tasks.restore` handles multiple restore paths via a single canonical verb.

### 5. Are all ops at the correct tier?

All 6 ops are Tier 0 (`sessionRequired: false`). This is correct: sticky notes are session-independent quick-capture artifacts. There is no reason to require an active session to jot a note or retrieve one. Tier 0 is the right classification.

### 6. Do verb names follow VERB-STANDARDS?

- `list`, `show`, `add`, `archive`, `purge` — all canonical verbs per VERB-STANDARDS.md
- `convert` — not explicitly listed in VERB-STANDARDS.md but there is no canonical alternative. The verb is domain-appropriate, clear in intent, and used consistently. No violation.

---

## Validation Verdict

All 6 operations are defensible. The sticky domain is correctly lean:

- 2 query ops (list, show) — minimal read surface
- 4 mutate ops (add, convert, archive, purge) — complete lifecycle coverage
- Zero redundancy with other domains
- Zero naming violations against canonical verbs
- Tier 0 classification is correct across the board
- Core implementation exists in `src/core/sticky/` with dedicated modules per operation

**Recommendation**: No changes required. Domain is at its natural floor — removing any op would break the capture-classify-promote lifecycle.

---

## References

- `src/dispatch/registry.ts` — Registry entries at lines 2793–2866
- `src/dispatch/domains/sticky.ts` — Domain handler (getSupportedOperations: query:[list,show], mutate:[add,convert,archive,purge])
- `src/dispatch/engines/sticky-engine.ts` — Engine layer
- `src/core/sticky/` — Business logic (8 modules)
- `docs/specs/VERB-STANDARDS.md` — Canonical verb reference
- T5282 — Original sticky domain implementation task
- T5267 / T5277 — Sticky epic tasks
