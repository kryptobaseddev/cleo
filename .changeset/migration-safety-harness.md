---
id: migration-safety-harness
tasks: [T13448]
kind: feat
summary: Migration safety harness — backup/verify/rollback bracket for every store move (saga T13339)
---

Every CleoDocs re-architecture store move (the T13360 migration, the T13361/T13362 legacy retirements) now wraps its steps in one reusable harness instead of hand-rolling per-migration safety. `runMigrationSteps` executes each registered step (`{ name, run, destructive?, verify? }`) inside a fixed bracket: a pre-step `VACUUM INTO` snapshot registered as a `migration` system backup whose `<backupId>.meta.json` sidecar is the step's backup receipt, then the step body, then verification, then a machine-readable report.

Verification compares per-table row counts before/after (a delta must be explained by the step's declared `expectedDelta`), content-hash spot checks (an order-independent multiset hash, sampled to 200 rowids on tables larger than the sample size, so a verbatim T11649 table rebuild still matches), and `PRAGMA foreign_key_check` (must return zero rows). A failed verification auto-halts the runner, names the failed step, and leaves the rollback path ready: the halted step's report carries the backup receipt and pre-step fingerprints that `rollbackMigrationStep` consumes to restore the snapshot through the programmatic core of `cleo restore backup` (T13240) and re-prove counts, content hashes and file bytes against the pre-step snapshot.

Destructive steps refuse to run without `force: true` plus a backup receipt younger than the step start — guaranteed by construction, because the harness takes the snapshot before the guard runs. Proven against a real-shaped store at scale: the test seeds the actual T13354 conduit-history tables with thousands of rows plus blob files, runs a no-op rebuild of one history table through the harness, and rolls back with byte/count equality (12 new tests, all green; raw-write gates 28/38 clean in PR mode).
