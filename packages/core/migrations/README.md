# CLEO Migration System — Hybrid Path A+

> **Decision record**: [`docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md`](../../../docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md)
> **Epic**: T1150 (T-MSR RCASD) — Wave 2A implementation
> **Synthesis**: [`.cleo/agent-outputs/T-MSR/RECOMMENDATION.md`](../../../.cleo/agent-outputs/T-MSR/RECOMMENDATION.md)

This is the living guide for authoring, maintaining, and recovering migrations in the CLEO
`packages/core/migrations/` canonical tree. Read this before writing any migration SQL.

---

## Overview — 5 DBs and Their Purpose

CLEO manages five SQLite databases. Four use `packages/core/src/store/migration-manager.ts`
as their runtime migration orchestrator. `signaldock.db` has a structurally distinct
embedded runner (see [signaldock note](#signaldock-structural-note) below).

| DB | Scope | Schema file | Migration folder | Runtime runner |
|---|---|---|---|---|
| `tasks` | project-level | `packages/core/src/store/tasks-schema.ts` | `drizzle-tasks/` | `migration-manager.ts` |
| `brain` | project-level | `packages/core/src/store/memory-schema.ts` | `drizzle-brain/` | `migration-manager.ts` |
| `nexus` | global/cross-project | `packages/core/src/store/nexus-schema.ts` | `drizzle-nexus/` | `migration-manager.ts` |
| `signaldock` | global/cross-project | `packages/core/src/store/signaldock-schema.ts` | `drizzle-signaldock/` | bespoke embedded runner |
| `telemetry` | opt-in CLI telemetry | `packages/core/src/telemetry/schema.ts` | `drizzle-telemetry/` | `migration-manager.ts` |

The canonical tree lives here at `packages/core/migrations/`. A build-time copy exists at
`packages/cleo/migrations/` (written by `syncMigrationsToCleoPackage()` in `build.mjs`) to
work around `__dirname` math in the CLI bundle. The `packages/cleo/migrations/` copy is a
build artefact — **never edit it directly**.

### Core Principle (Hybrid Path A+)

`migration-manager.ts` (`reconcileJournal()` and six production patches) is the **runtime
SSoT**. drizzle-kit is retained as a `devDependency` for **scaffolding only**: it generates
DDL proposals that developers curate, then rename and promote to the canonical tree via
`scripts/new-migration.mjs`. drizzle-kit does NOT own the `__drizzle_migrations` journal,
does NOT gate deploys, and does NOT run at startup.

---

## Authoring a New Migration

### Step-by-step

**1. Edit the schema file.**

Modify the appropriate schema TypeScript file for your DB (see table above). Use
drizzle-orm column builders — `sqliteTable`, `text`, `integer`, `index`, etc. For partial
indexes, use `.where()` on `IndexBuilder` (supported in drizzle-orm beta.22+; see
[Partial Indexes](#partial-indexes) below).

**2. Run the generator.**

```bash
pnpm db:new -- --db <name> --task <TNNNN> --name <kebab-desc>
```

Examples:

```bash
pnpm db:new -- --db tasks --task T1234 --name add-priority-column
pnpm db:new -- --db brain --task T1234 --name add-embedding-table
pnpm db:new -- --db nexus --task T1234 --name add-project-registry
```

Optional flags:

```bash
--commit    Auto-commit the generated migration folder after linter passes
--apply     Run migrateSanitized on a fresh temp DB for local inspection (does not commit)
```

**3. What the generator does (in order).**

The `scripts/new-migration.mjs` wrapper:

1. Resolves a throwaway temp-DB path (never touches production DBs).
2. Invokes `node_modules/.bin/drizzle-kit generate --config=drizzle/<db>.config.ts`.
3. Post-processes `migration.sql` — strips trailing `--> statement-breakpoint` markers so
   the file ends cleanly with `;\n`.
4. Renames the drizzle-kit auto-generated folder slug to the CLEO convention:
   `YYYYMMDDHHMMSS_<auto-name>/` → `YYYYMMDDHHMMSS_tNNNN-<kebab-desc>/`.
5. Runs `scripts/lint-migrations.mjs` — aborts on RULE-1 ERRORs.
6. Prints the generated `migration.sql` for human review.

> **Critical**: Always use `node_modules/.bin/drizzle-kit` (the local binary). Never use
> `pnpm dlx drizzle-kit` — it is incompatible with the custom drizzle-orm build
> (established by ADR-054 R3 §1.1).

**4. Review the generated output.**

Inspect `migration.sql` and `snapshot.json` in the newly created folder. Verify:

- The DDL delta matches your schema change exactly.
- No `PRAGMA foreign_keys=OFF` block unless you specifically intended a table rebuild
  (brain.db FK-off blocks require human review before production apply — see ADR-054 R3 §3.2).
- No trailing `--> statement-breakpoint` (the generator strips these, but verify).

**5. Commit with a task-linked message.**

```bash
git add packages/core/migrations/drizzle-<db>/<timestamp>_tNNNN-<slug>/
git commit -m "feat(TNNNN): <description> migration"
```

Or use `--commit` flag on the generator to auto-commit after the linter passes.

### Migration folder anatomy

```
packages/core/migrations/drizzle-tasks/
  20260421000001_t1126-sentient-proposal-index/
    migration.sql      ← DDL applied by the runtime (readMigrationFiles reads this)
    snapshot.json      ← drizzle-kit state snapshot (advisory; NOT read at runtime)
```

Both files are committed together. `snapshot.json` is the anchor for `drizzle-kit generate`
to produce incremental diffs on the next migration — do not delete it.

---

## Partial Indexes

Use `.where()` on `IndexBuilder` in the schema TypeScript file. drizzle-orm beta.22+
supports it correctly (the previous comment in `tasks-schema.ts` claiming `.where()` was
unsupported was incorrect — corrected by T1170).

```typescript
// packages/core/src/store/tasks-schema.ts
export const idxTasksSentientProposalsToday = index(
  'idx_tasks_sentient_proposals_today',
).on(tasks.type, tasks.sentientProposedAt)
  .where(sql`sentient_proposed_at >= strftime('%s','now','-1 day')`);
```

After editing the schema, generate the migration via `pnpm db:new` as normal. The generator
invokes drizzle-kit which emits the `CREATE INDEX ... WHERE ...` SQL.

See T1126 (`20260421000001_t1126-sentient-proposal-index`) as the canonical example once
T1174 lands. Prior to T1174, that index was hand-authored — T1174 regenerates it via schema.

---

## Runtime Contract

`packages/core/src/store/migration-manager.ts` is the single source of truth for migration
state at runtime. Understanding what it guarantees is essential before debugging migration
issues.

### What the reconciler does

`reconcileJournal(nativeDb, migrationsFolder, existenceTable, logSubsystem)` runs before
every `migrate()` call and handles four scenarios:

**Scenario 1 — Tables exist but no `__drizzle_migrations` journal (fresh-to-upgraded install)**

If the existence table is present but the journal table is absent, the reconciler creates
`__drizzle_migrations` and inserts the baseline migration as already applied. This handles
the case where a user ran an older CLEO that did not use drizzle's migration journal at all.

**Scenario 2 — Orphaned journal entries (DB ahead of local install, or stale hashes from
a prior version)**

The reconciler distinguishes two sub-cases:
- *Sub-case A*: All local migration hashes are present in the journal AND there are extra
  entries the local install does not recognise. The DB was written by a newer version — log
  at debug and pass through without modifying the journal (preventing a destructive loop).
- *Sub-case B*: Some local hashes are absent from the journal AND there are unrecognised
  entries. Genuine hash algorithm drift from an older CLEO version. The reconciler clears
  the journal and re-probes each local migration's DDL, marking applied only if all DDL
  targets exist in the live schema.

**Scenario 3 — Partial migration (column exists but no journal row)**

A migration was partially applied — the `ALTER TABLE ADD COLUMN` ran but the journal
`INSERT` never committed (process crash, worktree cherry-pick, etc.). The reconciler
probes each unjournaled migration's DDL targets:
- All targets present → mark applied.
- Some targets present, some absent (T920 sub-case) → idempotently add missing columns
  then mark applied.
- No recognisable DDL targets → leave for drizzle's `migrate()` to run normally.

Also handles the T1165 baseline marker pattern: a `migration.sql` containing only SQL
comments (no executable DDL) is marked applied immediately on existing DBs.

**Scenario 4 — Null-name journal rows (pre-v1-beta installs)**

drizzle-orm v1 beta identifies applied migrations by `name`, not `hash`. Journal rows
without a `name` value (written by older CLEO code) are treated as unapplied, causing
re-runs and duplicate-column crashes. The reconciler backfills the `name` column from
the local migration files matched by hash.

### `migrateSanitized`

All call sites use `migrateSanitized(db, { migrationsFolder })` rather than drizzle's
`migrate()` directly. `migrateSanitized` filters two classes of non-executable SQL
statements before they reach drizzle's `session.run()`:

1. **Whitespace-only** — produced by drizzle-kit's trailing `--> statement-breakpoint`
   marker splitting.
2. **Comment-only** — the T1165 baseline marker pattern (`migration.sql` containing only
   SQL comments).

This is a defence-in-depth layer. The generator already strips trailing breakpoints at
authoring time; `migrateSanitized` catches any that slip through.

### Accumulated patches

The reconciler carries six production patches. All are still required for production safety;
removing any causes hard failures on existing installations.

| Patch | Task | Edge case handled |
|-------|------|-------------------|
| Orphaned hash reconciliation | T632 | Hash algorithm changed across Drizzle v0→v1; old DBs had stale journal entries |
| Partial application handling | T920 | Multi-statement migrations crash mid-execution, leaving partially-applied state |
| Rename-via-drop+create detection | T1135 | `RENAME TO` migration idiom bypassed the column-add probe loop |
| Drizzle v1 beta name-field backfill | T1137 | Pre-v1-beta code did not write the `name` column; `null` names caused re-runs |
| Bootstrap baseline for orphaned tables | T1141 | Tables existing without a journal required probe-and-mark-applied on first run |
| SQLITE_BUSY exponential backoff | T5185 | Parallel CLI invocations on the same DB race on the SQLite write lock |

T1137 may be deprecated in v2026.6.0 once all installations have passed the drizzle v1-beta
upgrade window. The other five patches must remain indefinitely.

### signaldock structural note

`drizzle-signaldock/` is covered by a drizzle-kit config for scaffolding, but `signaldock.db`
itself uses a bespoke embedded runner (`_signaldock_migrations` table,
`GLOBAL_EMBEDDED_MIGRATIONS` array in `signaldock-sqlite.ts`) rather than `migration-manager.ts`.
Running `pnpm db:new -- --db signaldock` emits a warning and proceeds; the linter catches
any convention violations. Bringing signaldock fully into the `migration-manager.ts` runtime
is an epic-scale refactor out of scope for Wave 2A (ADR-054 R3 §6.1).

---

## Linter Rules

`scripts/lint-migrations.mjs` runs automatically at the end of every `pnpm db:new`
invocation. It is also wired into the pre-commit hook and the CI `migration-lint` job.

Run manually:

```bash
node scripts/lint-migrations.mjs
```

With options:

```bash
node scripts/lint-migrations.mjs --migrations-root packages/core/migrations
node scripts/lint-migrations.mjs --fail-on=warn    # exit 1 on any violation
node scripts/lint-migrations.mjs --fail-on=none    # report-only, always exit 0
```

### RULE-1 (ERROR): No trailing `--> statement-breakpoint`

A `migration.sql` file MUST NOT end with `--> statement-breakpoint` followed by only
whitespace. This marker is a drizzle-kit hint for its own runner; it signals that the last
SQL statement was never written. The generator strips it automatically; the linter enforces
it at both pre-commit and CI stages.

### RULE-2 (ERROR): No timestamp collisions

Within a single DB set, each folder MUST begin with a unique 14-digit timestamp. Two folders
sharing the same timestamp prefix cause non-deterministic migration ordering and break the
reconciler. The generator uses the current UTC time at invocation; avoid running the
generator twice in the same second.

### RULE-3 (WARN): Orphan snapshot

A `snapshot.json` without a sibling `migration.sql` in the same folder is flagged.
A `migration.sql` without a sibling `snapshot.json` in a DB set where other folders
have snapshots is also flagged — this signals a hand-rolled migration was added after
the baseline reset, breaking the snapshot chain. Always use the generator.

### RULE-4 (ERROR/WARN): Invalid folder naming

Standard migration folders MUST match `/^\d{14}_[a-z0-9-]+$/`. The 14-digit prefix is the
UTC timestamp; the suffix is the task-linked slug (e.g., `t1234-add-priority-column`).
Flat `.sql` files found directly in a DB set directory (not inside a subfolder) are flagged
as WARN — this was the signaldock structural anomaly before T1166 converted it to the
standard folder structure.

---

## Forbidden Patterns

These patterns are caught by the linter and/or reconciler, but are listed explicitly to
prevent authoring mistakes.

| Pattern | Why it is forbidden | What to do instead |
|---|---|---|
| Hand-editing `migration.sql` after it has been committed | Changes the file content → changes the hash → breaks the `__drizzle_migrations` journal on existing installs | Amend before push (if not yet merged); write a new forward migration if already merged |
| Timestamp collisions across sibling folders | Non-deterministic migration ordering; RULE-2 ERROR | Use the generator — it stamps the current UTC time automatically |
| Trailing `--> statement-breakpoint` at end of file | Signals truncated output; `migrateSanitized` filters it but RULE-1 treats it as an error | The generator strips it; if hand-authoring, ensure the file ends with `;\n` |
| Bypassing the generator and hand-writing migrations without `snapshot.json` | Breaks the drizzle-kit diff chain; RULE-3 WARN accumulates until baseline reset | Always use `pnpm db:new` |
| Writing migrations to `drizzle/migrations/` | This directory no longer exists (deleted by T1167); it was a stale scratchpad | Write to `packages/core/migrations/drizzle-<db>/` only — the generator does this automatically |
| Using `pnpm dlx drizzle-kit` | Incompatible with the custom drizzle-orm build (ADR-054 R3 §1.1) | Use `node_modules/.bin/drizzle-kit` — the generator calls it correctly |

---

## Adding a New DB Set

Follow these steps when introducing a new fifth (or later) database to CLEO.

**1. Author the schema file.**

Create the schema TypeScript file under `packages/core/src/store/` (or the appropriate
domain directory). Use `sqliteTable` from drizzle-orm.

**2. Create a drizzle-kit config.**

Add `drizzle/<db>.config.ts` with `out`, `dbCredentials`, and `schema` pointing to the new
schema file. Follow the pattern of existing configs (see `drizzle/tasks.config.ts`). The
`dbCredentials.url` MUST read from the appropriate `CLEO_DRIZZLE_BASELINE_<DB>_DB`
environment variable so the generator can pass a throwaway temp-DB path.

**3. Register in the generator.**

Add the new DB name to the `VALID_DBS` array in `scripts/new-migration.mjs` and the
`DB_ENV_VAR_MAP` object with its environment variable name.

**4. Create the initial migration.**

```bash
pnpm db:new -- --db <name> --task TNNNN --name initial
```

Review the generated SQL carefully — the first migration is the full schema creation.

**5. Wire the runtime.**

Call `reconcileJournal` then `migrateSanitized` (or `migrateWithRetry`) from the new DB
module's initialisation path. Pass the correct `existenceTable` name (a table whose
presence signals the DB has existing data) and a `logSubsystem` string for tracing.

**6. Add a smoke test.**

Add a migration smoke test under `packages/core/src/store/__tests__/migration-smoke.test.ts`
verifying that the migration applies cleanly to a fresh in-memory SQLite DB.

**7. Update CI.**

Add the new DB to the `db:check` script loop in root `package.json`. Verify the
`migration-lint` CI job scans the new `drizzle-<db>/` folder.

---

## Emergency: Partial-Migration Recovery

### What happens during an interrupted migration

If the process crashes between a `CREATE TABLE` or `ALTER TABLE` statement succeeding and
the `__drizzle_migrations` journal `INSERT` committing, the DB will have schema changes
that the journal does not record. On the next startup:

1. `reconcileJournal` Scenario 3 detects the unjournaled migration by probing its DDL
   targets against the live schema.
2. If all targets are present, the journal entry is inserted and `migrate()` skips the
   migration normally.
3. If only some targets are present (T920 sub-case), missing columns are added idempotently
   before marking applied.

In most cases the reconciler self-heals without operator intervention.

### When operator action is required

If `__drizzle_migrations` rows are visibly out of sync with schema state and the reconciler
has not self-healed (observable via `cleo admin` or direct `sqlite3` inspection):

**Step 1 — Take a backup before touching anything.**

```bash
cleo backup add
```

**Step 2 — Inspect the journal.**

```bash
sqlite3 .cleo/tasks.db "SELECT id, hash, name FROM __drizzle_migrations ORDER BY created_at;"
```

**Step 3 — Identify the offending migration.**

Compare journal entries against `packages/core/migrations/drizzle-<db>/` folder names. A
folder with no matching journal row is the candidate.

**Step 4 — Insert the missing journal entry manually (last resort).**

Only do this if the schema DDL for the migration has already been applied and the
reconciler Scenario 3 did not auto-heal. Obtain the hash from the local migration folder
(it is the SHA-256 of the migration SQL — drizzle-orm derives it internally). As a
shortcut, restart the CLEO process; the reconciler will attempt Scenario 3 on the next run.

**Step 5 — Verify with `cleo doctor`.**

```bash
cleo doctor
```

If the DB passes doctor checks, the recovery is complete.

**Step 6 — File a bug.**

If the reconciler did not self-heal a partial migration, file a bug with:
- The migration name and the set of columns that were/were not present.
- The CLEO version (`cleo version`).
- The full output of `cleo admin` and `sqlite3 .cleo/<db>.db ".schema"`.

---

## References

### Decision records

- [`docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md`](../../../docs/adr/ADR-054-migration-system-hybrid-path-a-plus.md) — canonical governance contract (supersedes ADR-012, ADR-027 §2.6)
- [`docs/adr/ADR-051-programmatic-gate-integrity.md`](../../../docs/adr/ADR-051-programmatic-gate-integrity.md) — evidence-based verify; informs the linter/guard/generator triad
- [`docs/adr/ADR-012-drizzle-kit-migration-system.md`](../../../docs/adr/ADR-012-drizzle-kit-migration-system.md) — original drizzle-kit adoption (superseded)

### Research synthesis

- [`.cleo/agent-outputs/T-MSR/RECOMMENDATION.md`](../../../.cleo/agent-outputs/T-MSR/RECOMMENDATION.md) — T1156 synthesis; primary decision source

### Key tasks

| Task | Title |
|---|---|
| T1150 | T-MSR RCASD epic (parent) |
| T1162 | T-MSR-META-01: governance bug (subagent unilateral lifecycle advance) |
| T1163 | W2A-01: Fix drizzle config out paths + add signaldock/telemetry configs |
| T1164 | W2A-02: Author `scripts/new-migration.mjs` generator wrapper |
| T1165 | W2A-03: Baseline-reset snapshot chains for tasks/brain/nexus |
| T1166 | W2A-04: Convert signaldock bare SQL bootstrap to standard folder structure |
| T1167 | W2A-05: Delete drizzle/ scratchpad folders |
| T1168 | W2A-06: Wire lint-migrations.mjs into pre-commit hook + CI |
| T1169 | W2A-07: Wire drizzle-kit check into CI as schema-consistency gate |
| T1170 | W2A-08: Fix stale `.where()`-not-supported comment in tasks-schema.ts |
| T1171 | W2A-10: Scan schema files for hand-rolled partial indexes |
| T1172 | W2A-11: Author this README (current task) |
| T1173 | W2A-12: Author ADR-054 |
| T1174 | W2A-09: Adopt `.where()` for T1126 partial index via schema |

### Source files

- `packages/core/src/store/migration-manager.ts` — runtime reconciler (663 lines, 6 patches)
- `scripts/new-migration.mjs` — generator wrapper (T1164)
- `scripts/lint-migrations.mjs` — migration linter (T1168)
- `drizzle/tasks.config.ts`, `drizzle/brain.config.ts`, `drizzle/nexus.config.ts`,
  `drizzle/signaldock.config.ts`, `drizzle/telemetry.config.ts` — drizzle-kit configs (T1163)

---

Last updated: 2026-04-21
