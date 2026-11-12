---
id: t14497-orca-launch-recovery
tasks: [T14497]
kind: fix
summary: "Orca execution: reserve first-launch keys and verify recovered request identity"
---

Reserve the initial launch key before committing worker custody, preserve exact-key crash recovery, and give expired claim holders a renewal and recovery command. Reject mismatched request receipts, verify adopted Dispatch bindings before stopping, and bound retained refusal diagnostics without treating truncated receipts as proof.
