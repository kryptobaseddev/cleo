---
id: claim-lease-repair-and-guard
tasks: [T12736, T12737]
kind: fix
summary: "repair stores where the t12502 claim-lease migration was only half applied; reconcileJournal refuses post-cutover migration hash drift instead of re-stamping it; VITEST exempts only fixture stores from the worktree-build schema guard"
---
Pre-release builds of the t12502 claim-lease migration each shipped a
different `migration.sql`. A store migrated by one of them and reopened by
another ended up with t12502 journaled but without the ISO-8601 CHECKs on
`claimed_at` / `lease_expires_at` and without `idx_tasks_sessions_spawned_by`.

- **Repair migration (T12736).** `20260929130000_t12736-claim-lease-iso-repair`
  creates the index `IF NOT EXISTS` and adds BEFORE INSERT / BEFORE UPDATE
  triggers on `tasks_tasks` that abort a non-ISO `claimed_at` or
  `lease_expires_at` (the same GLOB the CHECKs use). There is no table rebuild.
  Where t12502 applied fully the triggers only repeat the CHECKs. The
  reconciler's probe runs the migration on a half-applied store rather than
  stamping it, because its index and triggers are missing there.
- **Hash drift is refused (T12737).** A journal row with the name of a local
  post-consolidation migration but a different hash is no longer deleted as an
  orphan and re-stamped without running the new SQL. `reconcileJournal`
  throws `E_MIGRATION_HASH_DRIFT` naming the migration and both hashes. The
  fix text points to `cleo restore backup`, and
  `CLEO_ALLOW_MIGRATION_HASH_DRIFT=1` opts back into the old path.
  - Pre-consolidation migrations keep the released delete-and-re-probe
    path; several of them were edited across releases.
  - No post-consolidation `migration.sql` differs between any two release
    tags.
- **Stamp logging.** When Scenario 3 Case A or Case B stamps a migration
  without running its SQL, it now logs at error level.
- **Narrower VITEST exemption (T12737).** Under `VITEST`, the worktree-build
  schema guard now exempts only stores below `os.tmpdir()` (the fork sandbox).
  A test run from a worktree that reaches a real checkout's store is refused,
  and the handle authorizer is installed under the test harness too.
