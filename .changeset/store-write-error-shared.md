---
id: store-write-error-shared
tasks: [T14217]
kind: fix
summary: "cleo cancel reports a failed store write as E_INTERNAL with its SQLite cause again; the store and cancel share one bounded store-write helper"
---

After the diff-only task writes (T14218) wrapped a failed task write in a
`CleoError`, `cleo cancel` no longer recognised drizzle's raw `Failed query:`
error and reported `E_CLEO_GENERAL` instead of a bounded `E_INTERNAL` with the
SQLite cause (T14217). One helper in `store/db-helpers.ts` now reads the
SQLite cause and the start of the statement for both: `taskWriteError` builds
the wrap from it and marks a write that failed for no known rule, and
`boundedStoreWriteFailure` turns either that wrap or a raw failed query into
the bounded `E_INTERNAL` message `cleo cancel` returns. Refusals with a known
trigger code keep their own exit codes.
