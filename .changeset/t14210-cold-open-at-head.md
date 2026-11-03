---
id: t14210-cold-open-at-head
tasks: [T14210]
kind: fix
summary: "Opening a store whose schema is already current no longer takes the write lock, so a read never waits behind another writer (T14210)"
---

Every first bind of the tasks and brain domains in a process claimed the
cold-open writer lease, and the claim is a `BEGIN IMMEDIATE`. So any command,
read-only ones included, waited out the 30 s busy timeout while another process
held the store's write lock.

Each domain now first decides by a read whether its schema work would write
anything. The read uses the same sources the work does: the lineage's migration
journal, the `ensureColumns` lists, the attachments version columns, the
twin-table collapse state, the seeded meta keys and the brain embeddings table.
A store at head is bound without the lease. A store that needs any schema work
takes the leased path as before, so migrations stay serialised. The schema work
itself no longer writes on a current store: the journal de-duplication and the
meta seeds read before they write.
