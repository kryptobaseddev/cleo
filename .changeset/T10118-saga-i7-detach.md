---
"@cleocode/cleo": patch
"@cleocode/core": patch
"@cleocode/contracts": patch
---

feat(T10118): wire I7 gate into sagaAdd + cleo saga detach verb

sagaAdd now calls assertSagaInvariantI7 — rejects member candidates whose labels
include 'saga' with E_SAGA_INVARIANT_VIOLATION_I7. Adds cleo saga detach <sagaId>
<memberId> idempotent repair verb (audit log at .cleo/audit/saga-detach.jsonl).
Detaches T9831 from T9799 in dogfood. Saga: T10113. Epic: T10209.
