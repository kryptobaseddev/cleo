---
id: t10109-show-validates-task-id
tasks: [T10109]
kind: fix
summary: cleo show validates task ID format — malformed IDs (T932EP, T-foo, garbage) return clean LAFS envelope, never KeyError
---

Defensive format validation added to `showTask` (packages/core/src/tasks/show.ts). Rejects non-canonical task IDs at parse time with `INVALID_INPUT` instead of silently falling through to a misleading `NOT_FOUND` (or worse, a KeyError downstream from a parse-time crash in a non-LAFS caller).

The dispatch sanitizer middleware (sanitizeTaskId / sanitizeParams) already short-circuits malformed inputs with `E_VALIDATION_FAILED` for CLI flows; this PR adds a second defensive layer in `showTask` itself for direct in-process consumers (tests, SDK callers, future API surfaces) so the contract is uniform.

15 new unit tests + 11 new integration tests lock in the envelope contract for every input in the T10109 acceptance set: `T932EP`, `T-foo`, `t9999`, `""`, `T`, `T0`, `TASKABC`, `garbage`, `T123abc`, `T 123` — all return a structured LAFS envelope (`{success: false, error: {code, message}}`), never a stack trace.
