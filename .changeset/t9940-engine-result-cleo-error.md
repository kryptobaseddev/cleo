---
id: t9940-engine-result-cleo-error
tasks: [T9940]
kind: fix
summary: engine-result wrappers preserve CleoError LAFS codes across tasks domain
---

Generalizes the T9838-D fix from `tasks/update.ts` to ALL task engine-result wrappers (delete, archive, list, find, labels, plan, show, session-scope, and the central engine-wrap helpers). Adds `cleoErrorToEngineResult` SSoT helper in `packages/core/src/errors-to-engine.ts` that:

- Extracts the real LAFS code from any thrown `CleoError` via `toLAFSError()` (`E_CLEO_VALIDATION`, `E_CLEO_NOT_FOUND`, `E_CLEO_PARENT_NOT_FOUND`, etc.)
- Forwards rich `fix` / `alternatives` / `details` / `exitCode` fields
- Falls through to `E_INTERNAL` for non-CleoError exceptions (no more blanket `E_NOT_INITIALIZED` mis-label)

Status transitions and DB-invariant trigger violations now surface with their actual catalog codes rather than the misleading `E_NOT_INITIALIZED` blanket label that previously hid real failure modes.
