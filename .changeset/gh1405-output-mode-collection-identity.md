---
id: gh1405-output-mode-collection-identity
tasks: [T12194]
kind: fix
summary: "--output id/count/table/summary project each collection's declared identity and refuse rather than emitting an empty stream (gh#1405, gh#1402)"
---

`cleo worktree list --output count` returned **0** while the envelope it had
just built held 9 records, and `--output id` returned nothing. Both projection
modes agreed on a wrong answer, which is what made this worse than its siblings
rather than another instance of them.

## Measured before

| verb | collection key | rows | `--output count` | `--output id` |
|---|---|---|---|---|
| `worktree list` | `worktrees` | 9 | **0** | **0** |
| `saga list` | `sagas` | 58 | 58 | **0** |
| `backup list` | `backups` | 55 | 55 | **0** |

Two independent causes, both of which fail toward a plausible empty:

1. **The collection key was absent from the SSoT.** `COLLECTION_KEYS` listed
   `tasks | items | results | suggestions`. `sagas`, `backups` and `worktrees`
   were in nobody's list. `saga list` and `backup list` still counted correctly
   only because they carry a `total`/`count` sibling field; `worktree list`
   carries neither, so the count fell through to `0` and the cross-check that
   caught the other two did not exist.
2. **Identity was assumed to be `id`.** Worktrees identify by `path` and backups
   by `backupId`. The projection dropped every row lacking `id`, silently.

## What changed

- `sagas`, `backups`, `worktrees` added to the `COLLECTION_KEYS` SSoT.
- New `COLLECTION_IDENTITY_FIELDS` registry declares a collection's identity
  where it is not `id`. `--output id`, `--output table` and `--summary` all
  project through it.
- **`--output id` now REFUSES** with `E_OUTPUT_IDENTITY_UNDECLARED` (exit 2)
  when rows are present but none yields an identity. A genuinely empty
  collection is unchanged — empty stream, exit 0 — because zero rows is a
  truthful empty stream and only "rows exist and I cannot name them" is a lie.
- **An unlisted key no longer degrades to zero.** This file had been patched
  three times by adding a key to a list, and each miss produced a confident
  zero because an absent key and an empty collection render identically. When
  no known key matches, resolution now falls back to the payload's own shape —
  deliberately narrow: exactly one top-level array of records, so a payload
  carrying rows plus an incidental array still resolves to nothing and takes
  the single-record path exactly as before.

## Verified

Against the live CLI, after the change:

| verb | envelope | `--output count` | `--output id` | agree |
|---|---|---|---|---|
| `worktree list` | 6 | 6 | 6 | yes |
| `saga list` | 58 | 58 | 58 | yes |
| `backup list` | 55 | 55 | 55 | yes |

and `--output id` emits paths, `backupId`s and task ids respectively.

The control matters as much: `cleo find test` still reports envelope 20 /
`--output count` 638. That disagreement is **correct** — `count` is the
filter-aware match count by design (T11481) while the envelope carries a page,
and `detectTruncation` already discloses it. The invariant asserted in tests is
therefore `--output id` line count == envelope rows, NOT `count` == rows;
encoding the latter would have made a true design decision look like a bug.
