---
id: doctor-projects-registry-integrity
tasks: [T12471]
kind: feat
summary: "New `cleo doctor projects` checks every registry row machine-wide: it rebinds moved projects by id, flags split identities, missing, temp and home/root rows with the exact remedy, and receipts every change. `nexus projects clean --orphans` no longer deletes a project that moved"
---
The registry is keyed by project id (ADR-094), but its paths go stale when a
project is moved, deleted or re-initialized under a new id. `cleo doctor
projects` probes every row and scans the directories projects live in (the
parent of every registered path, plus `--roots`) for `.cleo/` declarations.

- Read-only by default (`--dry-run` is the same). Each row is classified as
  `moved`, `ambiguous`, `split`, `possible-split`, `missing`, `temp` (under a
  temp directory while the registry is persistent), `root` (home directory or
  a filesystem root), `unreadable` or `other-device`. Every non-ok row carries
  the exact remedy. Exits 1 when any row needs attention.
- A row is rebound only with NONCE proof: the target's untracked checkout
  nonce equals one recorded for the id (T12470 · #1606). An `id-only` match (a
  clone with its own nonce, a copied `.cleo/project-id`) is reported with the
  `cleo doctor project-identity --resolve` remedy and never applied. Paths in
  a trash directory or the CLEO home, paths holding a valid reroot tombstone,
  and locations demoted to `missing` in reroot geometry are never targets.
- `split` needs repository evidence (same git remote or root commit; nested
  CLEO projects inside another registered project are excluded). A name-only
  match is `possible-split`: inspect only, and the gone row's location is
  still recorded `missing`.
- `--apply` rebinds `moved` rows and records `missing` locations. It deletes
  nothing and writes only registry rows. Filesystem probes run BEFORE the
  write transaction. The rows it can change (including migration-backfilled
  `local` location rows the writers re-key) are imaged before and after, and
  both images are written to `nexus_audit_log` in the same transaction. A row
  that changed since the inspection is skipped. Split, ambiguous, temp and
  root rows are owner decisions and are never changed.
- `--rollback <receiptId>` restores the before image. It is refused when any
  row in the receipt's scope changed after the repair, or when the receipt was
  already rolled back.
- Probes are bounded: `--concurrency` reads at once (default 16), each with a
  `--timeout-ms` budget (default 2000). Only ENOENT/ENOTDIR prove a path gone;
  EACCES, EPERM or a timeout leave the row `unreadable` and untouched.
- `cleo nexus projects clean` refuses to delete a matched row whose path is
  gone but whose id is found at another path (a recorded location that still
  declares it, or a scan of the registry's parent directories; trash excluded).
  Such rows are returned under `relocated` with the `cleo doctor projects`
  remedy. A path is gone only when it is absent (ENOENT/ENOTDIR) or declares a
  different id; an unreadable path (EACCES, EPERM, timeout) is never removed
  and is returned under `unreadable`.
- The project scanners skip `.Trash`, `.Trashes`, `$RECYCLE.BIN`, `Library`,
  `.local`, `.npm` and `.pnpm-store`.
