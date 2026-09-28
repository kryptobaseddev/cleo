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
  `moved` (exactly one other path declares the id; `proof` says whether its
  untracked checkout nonce matches), `ambiguous` (several paths declare it),
  `split` (the path is gone and a same-named directory holds a different id,
  or two registered rows share a git remote), `missing`, `temp` (under a temp
  directory while the registry is persistent), `root` (home directory or a
  filesystem root), `unreadable` or `other-device`. Every non-ok row carries
  the exact remedy. Exits 1 when any row needs attention.
- `--apply` rebinds `moved` rows by id and records `missing` locations as
  missing. It deletes nothing and writes only registry rows. The rows it can
  change are imaged before and after, and both images are written to
  `nexus_audit_log` in the same transaction. A row that changed since the
  inspection is skipped. Split, ambiguous, temp and root rows are owner
  decisions and are never changed.
- `--rollback <receiptId>` restores the before image. It is refused when any
  row in the receipt's scope changed after the repair, or when the receipt was
  already rolled back.
- Probes are bounded: `--concurrency` reads at once (default 16), each with a
  `--timeout-ms` budget (default 2000). Only ENOENT/ENOTDIR prove a path gone;
  EACCES, EPERM or a timeout leave the row `unreadable` and untouched.
- `cleo nexus projects clean` refuses to delete a matched row whose path is
  gone but whose id is found at another path (a recorded location that still
  declares it, or a scan of the registry's parent directories). Such rows are
  returned under `relocated` with the `cleo doctor projects` remedy.
