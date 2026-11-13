---
slug: brain-recovery-runbook
type: note
task: T14548
epic: T14547
description: "Operator runbook: lossless project and global store recovery"
---

# Store Recovery Runbook

After installing the stable CLEO release, run this command in the affected project:

```bash
cleo doctor repair-store
```

It preserves the original store and salvages readable data in one operation. A
healthy store with no pending repair is a no-op, including a second run after
a successful repair. `E_DB_CORRUPT`
always supplies `cleo doctor repair-store` as its fix. Ordinary store opens try
the same repair automatically when they can prove that nobody holds the store;
the command's warning includes the recovery receipt.

The project store is `.cleo/cleo.db`. It contains tasks, brain, conduit and the
other project domains together. Legacy `.cleo/tasks.db` and `.cleo/brain.db`
are not the live store. To repair the global consolidated store instead, use:

```bash
cleo doctor repair-store --global
```

## What the command preserves

Before repair, CLEO copies the main file and its existing `-wal`, `-shm` and
`-journal` sidecars into a new `.cleo/quarantine/<iso>-<unique>/` directory.
`receipt.json` records their SHA-256 hashes. Existing quarantine copies are
never overwritten or opened for salvage; all extraction uses disposable copies.
Global-store quarantine lives beside the global `cleo.db`.

CLEO reads the damaged main file both with and without its WAL. It tries
`sqlite3 .recover --ignore-freelist` when available and also reads tables through
Node SQLite, seeking past unreadable b-tree ranges. The freshest snapshot that
passes `integrity_check` is the merge base. With no usable snapshot, CLEO creates
a current empty schema and adds the readable rows.

Schema migrations run before and after the data merge so columns added after an
old snapshot are available before rows are imported. Missing primary keys are
inserted. Readable damaged-store values win a conflicting key unless timestamps
prove the snapshot row newer. An older main-only fallback keeps the snapshot
row when no timestamp proves it newer; its alternate values and source view
are recorded as a conflict. This also preserves ended sessions in tables
without update timestamps. Columns absent from the current schema are preserved
in quarantine `recovery.json` instead of silently discarded; salvaged migration
stamps cannot skip schema upgrades.

A complete read of the main-with-WAL table proves which snapshot rows were
deleted; those rows are excluded and listed as deletions. When a read is
incomplete, snapshot rows remain and are listed as possibly resurrected.
UNIQUE collisions and foreign-key orphans are excluded from the healthy result
and preserved with their values and reasons in `recovery.json`. Other readable
rows still merge. FTS and vector shadow storage is rebuilt through its logical
content tables, never imported row by row.

Before commit, the merged result must pass `integrity_check`, an empty
`foreign_key_check`, and base row-count checks adjusted only for recorded
deletions, quarantined snapshot conflicts, and rebuilt derived storage. CLEO then
validates the exact installable image against a copy of the original main file
and sidecars. It commits a full-image SQLite WAL with one fsynced atomic rename.
There is no window with a removed original WAL or an old WAL over a new main.
The full-image WAL includes page 1, so it also repairs a destroyed main-file
header without replaying the old WAL. Its page size comes from the staged
image. Original SHM is included in the install proof; the new WAL salts and
checksums force SQLite to rebuild a stale WAL index.

Immediately after the rename, still under the repair lock, CLEO runs
`PRAGMA wal_checkpoint(TRUNCATE)` and verifies a main-only copy with no sidecars.
Success is reported only after that proof. If the process is killed between
publication and verification, the full WAL keeps the store valid. The receipt
has `checkpoint-pending` status and image hashes. Running the same command
recognizes that published image, finishes the checkpoint and verification, then
returns a completed receipt. A dry-run previews that completion on copies.

The normal sync repair diff accounts for recovered rows: affected sync tables
are marked suspect rather than inventing journal sequence numbers during salvage.

## Inspect the receipt

The command's envelope and quarantine `receipt.json` include:

- The chosen snapshot, original file hashes, scope and final status.
- Per-table `snapshot`, `salvaged`, `merged`, `unreadable` and `final` counts.
- Task IDs mentioned in git commit messages since the snapshot but missing from
  the result. These are report-only; CLEO never invents their task records.
- Excluded column values, conflicts, proven deletions and possible resurrections,
  with lossless bigint and binary encodings in `recovery.json`.
- Extraction and optional-tool diagnostics. `unreadable: null` means damage hides
  the row count; it does not mean zero unreadable rows.

Overwritten or unreadable bytes cannot be recreated by salvage. Keep the
quarantine and receipt when investigating a missing record or a failed repair.
On a pre-commit failure, the live main file and sidecars remain byte-identical.
An interrupted attempt can be rerun with the same command.

## Busy stores and previews

Repair refuses an open store, including an idle connection. End the processes
holding it, then rerun the command. A failed liveness probe is not permission to
overwrite it. Linux checks kernel locks and process file descriptors through
`/proc`; macOS uses its system `fuser`; Windows probes an exclusive file open.
CLEO also checks its writer lock and live lease rows on a private copy. On Linux,
inaccessible descriptors for a possible store holder (`node`, `cleo`, `bun`,
`deno`, or `sqlite3`) refuse repair and name the PID. Other inaccessible processes
are identified through `/proc/<pid>/comm` and their skips appear in the receipt.
No `lsof` installation is required. Do not remove SQLite sidecars to make a
repair proceed.

```bash
cleo doctor repair-store --dry-run
cleo doctor repair-store --global --dry-run
```

Dry-run performs salvage, migration and validation on temporary copies and writes
nothing to `.cleo`. From a git worktree, an explicit repair of the owning
project's store also requires `--confirm-owner-store`. Its distinct
`E_WT_STORE_REWRITE_CONFIRM_REQUIRED` fix names that flag or the project root;
it is never rewrapped as corruption. Automatic repair after a failed canonical
open deliberately follows the existing open-time worktree policy: it repairs
the owner store only after proving exclusive access and appends an audited
`open-time` owner-store rewrite. Dry-run writes no audit or quarantine files.

## Backup recovery compatibility

`cleo backup recover tasks`, `cleo backup recover brain` and
`cleo backup recover conduit` use the same lossless merge by default.
`--from-snapshot <path-or-timestamp>` pins the base.
`--no-delta` explicitly retains snapshot-only recovery and discards readable
live rows written since that snapshot.

This runbook replaces the pre-consolidation brain-only snapshot-copy procedure
from T10303/T10304. That historical procedure could lose every post-snapshot row.
