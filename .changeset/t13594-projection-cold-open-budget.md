---
id: t13594-projection-cold-open-budget
tasks: [T13594]
kind: fix
summary: "A doc's graph projection no longer misses its deadline while the project store first opens"
---

`cleo docs add` projects each new doc into the knowledge graph under a 2 s
optional-maintenance deadline. When the project store had not been opened yet,
its cold open (schema migrations) was charged to that deadline, and under load
the projection was skipped as deadline-exceeded. The store is now opened
before the deadline starts. An audit of the other self-budgeted operations
found no other store opened inside its own budget.
