---
id: t10117-saga-list-repair
tasks: [T10117]
kind: fix
summary: sagaList includes all sagas + cleo saga repair verb
---

Replaces silent !parentId filter in sagaList with loud-include + structured I5-violation warnings. Adds cleo saga repair verb that detaches an I5-violating parentId and re-attaches via task_relations type='groups'. Idempotent. Saga: T10113; Epic: T10209.
