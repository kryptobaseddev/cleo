---
id: t13273-natural-key-apply
tasks: [T13273]
kind: fix
summary: Sync apply finds natural-key rows whose uid was never filled - own echoes no longer void on their origin
---

A natural-key row, such as a task dependency or a task relation, keeps a NULL uid until the open-time identity fill writes it. The
sealer still journals the row under its natural uid, which it derives from the key. The apply looked rows up by uid only, so it missed
such a row:

- **The own echo of every dependency or relation insert was voided on its origin.** The row looked unseen, the insert hit the UNIQUE key,
  and the apply recorded a guard conflict. The echo was then never sequenced and kept its undo.
- **A rebase could not rewind such a row,** so a foreign edge was judged against the un-rewound local edge and the replicas diverged.

Before planning a transaction, and before rewinding a local one, the apply now gives each unfilled natural-key row its uid. It finds the
row with no uid whose local key matches the op's key, with references resolved to local keys, and writes the uid. That is the same
derived value the identity fill writes, and capture never fires on the identity column.
