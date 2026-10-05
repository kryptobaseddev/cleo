---
id: t13193-footprints
tasks: [T13193, T13272]
kind: feat
summary: Rebase footprints widened by what guards and checks read; append-only rows never rewound
---

This is the first part of the fourth slice of the scoped rebase (T13193 R-4a), against journal spec §3.5 Rule 3 (R7-6).

- **Declared guard and check footprints.** `store/sync/apply/footprints.ts` declares what every guard trigger and every post-apply check
  reads beyond the op's own row and its references:
  - the parent chain (cycle guard);
  - the children of a retyped task (PAC-01);
  - the dependency closure (dependency-cycle guard).

  A rebase scope widens by those reads. So a local and a foreign write that together close a parent cycle through rows neither of them
  names are rebased, and the replicas converge. A gate test fails on a guard trigger with no declared footprint, and on a declaration for
  a guard that no longer exists.
- **UNIQUE keys.** A UNIQUE index beyond a table's identity, for example `tasks_tasks.idempotency_key` or the evidence-binding key, adds
  the key an op writes in full to the footprint as a pseudo-row. Two inserts that collide on the key now meet in a rebase.
- **Append-only rows are never rewound or replayed.** Their rows are insert-only under unique uids.
- **Snapshots of held inserts keep every value (T13272).** A held insert's kept snapshot now reads integers as BigInt and tags ±Infinity,
  so they round-trip exactly.
