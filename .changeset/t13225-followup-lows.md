---
id: t13225-followup-lows
tasks: [T13225, T13319, T13320]
kind: fix
summary: Sync refuses stores with partially stranded bare rows, and a crashed exodus run's lock refusal now says how to clear it
---

sync enable and the sealer now refuse any bare legacy table whose rows its sync-set twin lacks (missing keys, or a bare task shadowed by a reused id such as T001), not only a store whose tasks_tasks is empty. The refusal lists the counts and, for a populated store, says the reconcile cannot copy them yet (T13309). The exodus write refusal names the lock directory and the 10-minute stale window, and overlapping holds of one lock are counted. Also: genesis-cut prefix constant, Gate B refuses any cleo.db input, and changeset YAML round-trips prs. A verified reconcile now records in the store itself which bare tables it carried (key digest, in a local-only table that travels with backups, so a restored pre-reconcile snapshot is refused again), so a reconciled store whose prefixed rows are later deleted is not refused, and the seal-time check is decided once per data_version.
