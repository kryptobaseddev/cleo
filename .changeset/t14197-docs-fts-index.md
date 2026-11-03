---
id: t14197-docs-fts-index
tasks: [T14197]
kind: feat
summary: "memory find searches current docs by default, through a full-text index of the docs store (T14197)"
---

`memory find --docs` ranked every doc body per query with n-gram similarity,
about 3.5 s on a 3,312-doc store, so docs stayed opt-in. Docs now have a
derived FTS5 index (`docs_fts` in the project `cleo.db`, class `derived`,
never synced): one row per slugged text doc, ranked by BM25. It is kept in
step by diffing the store's slug and sha256 against the index after every docs
mutation and before every search, so it also picks up docs another writer or
device added, and a missing index is rebuilt from the store. A test over a
3,300-doc store holds each docs search under 300 ms.

The first docs search (or docs change) after upgrading builds the index: it
reads every doc body once, which takes a few seconds on a store of a few
thousand docs. After that only new or changed docs are read.

A search never fails or waits on the index write: it waits at most 250 ms for
the write lock, then searches the index as it stands (or, with no index yet,
falls back to the slower body scan), and a docs store it cannot read leaves the
BRAIN hits standing alone.

With that, an untyped `cleo memory find` includes current docs ranked with the
BRAIN hits; `--no-docs` leaves them out, and a search filtered by `--type` or
`--agent` adds them only with `--docs`. Superseded docs still never appear: a
match on one surfaces the doc that replaced it.
