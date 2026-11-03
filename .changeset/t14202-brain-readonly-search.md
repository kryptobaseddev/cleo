---
id: t14202-brain-readonly-search
tasks: [T14202]
kind: fix
summary: "cleo memory find no longer writes to the store or waits behind another writer (T14202)"
---

The first BRAIN search in every process rebuilt all four memory FTS indexes,
and it probed FTS5 by creating and dropping a table. Both are writes, and every
CLI call is a new process, so under any other writer `cleo memory find` waited
out the 30 s busy timeout (44 s in a repro with a held write lock).

A search now writes nothing when the indexes are present and in step: FTS5 is
detected from the compile options, and each index is checked read-only by
comparing its row count with its content table. Only a missing or stale index
is created or rebuilt, waiting at most 250 ms for the write lock; when the
store is busy, a stale index is searched as it stands and a missing one falls
back to a plain search.
