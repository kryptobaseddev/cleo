---
id: t12896-brain-integer-identity
tasks: [T12896]
kind: feat
summary: "Brain tables keyed by an autoincrement id get row uids; their local id never travels"
---

The brain tables keyed by an INTEGER AUTOINCREMENT id now carry a row uid in the
project and global stores: retrieval log, plasticity events, weight history,
modulators, consolidation events and usage log. The integer id numbers from 1 on
every device, so it stays a local key: sync never captures, seals or hashes an
INTEGER PRIMARY KEY, a received row gets the next local id, and the integer
references between these tables (plasticity event to retrieval, weight change to
both) travel as uids. A receiver drops the id if an older build's op still
carries it. AC history (also integer-keyed) stops sending its id the same way.
The event logs are append-only with a uid over a frozen content list; the
retrieval log is not, because its reward is labelled after the insert. The
migration `20261010140000_t12896-brain-autoinc-uids` adds the columns and unique
indexes. `brain_memory_trees` and `brain_task_observations` stay exempt for now.
