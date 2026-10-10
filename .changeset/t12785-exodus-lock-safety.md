---
id: t12785-exodus-lock-safety
tasks: [T12785]
kind: fix
summary: Exodus and the superseded-store reconcile stop cleanly when their single-flight lock is lost during a long stage, and ordinary writes from other processes are refused while either runs instead of racing the copy.
---
