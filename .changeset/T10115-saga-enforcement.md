---
"@cleocode/core": patch
"@cleocode/contracts": patch
---

feat(T10115): saga enforcement runtime gates (I3/I5/I7)

Pure-function guards assertSagaInvariantI3/I5/I7 in packages/core/src/sagas/enforcement.ts.
Throws SagaInvariantViolationError with code E_SAGA_INVARIANT_VIOLATION_I{3,5,7} and
structured diag payload. Foundation for T10118 sagaAdd wiring + T10119 doctor audit.
Saga: T10113. Epic: T10209.
