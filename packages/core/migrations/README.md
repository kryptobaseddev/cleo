# CLEO Migration System — Hybrid Path A+

> **Decision record**: [`docs/adr/adr-054-migration-system-hybrid-path-a-plus.md`](../../../docs/adr/adr-054-migration-system-hybrid-path-a-plus.md)
> **Epic**: T1150 (T-MSR RCASD) — Wave 2A implementation
> **Synthesis**: [`.cleo/agent-outputs/T-MSR/RECOMMENDATION.md`](../../../.cleo/agent-outputs/T-MSR/RECOMMENDATION.md)

This is the living guide for authoring, maintaining, and recovering migrations in the CLEO
`packages/core/migrations/` canonical tree. Read this before writing any migration SQL.

---

## Overview: two stores, one journal each

CLEO keeps its data in two SQLite stores, each one `cleo.db` with domain-prefixed tables:
the **project** store (`<project>/.cleo/cleo.db`) and the **global** store
(`<CLEO home>/cleo.db`). The former per-domain files (`tasks.db`, `brain.db`, `nexus.db`,
`conduit.db`, `signaldock.db`) are legacy; their data moved into the two stores, and
`signaldock.db` is retired.

Every open goes through `openDualScopeDb` (`packages/core/src/store/dual-scope-db.ts`), which
migrates the store with its consolidated lineage before returning it. Domain store modules then
apply the legacy lineages they still own to the same file, into the same journal:

| Store | Lineages that run against it | Where new migrations land |
|---|---|---|
| project `cleo.db` | `drizzle-cleo-project` (on open); `drizzle-tasks` (`store/sqlite.ts`), `drizzle-brain` (`store/memory-sqlite.ts`), `drizzle-nexus` (`store/nexus-sqlite.ts`, the delta only) and `drizzle-conduit` (`store/conduit-sqlite.ts`, the FTS5 quartet) | `drizzle-cleo-project` (newest folders through 2026-11); `drizzle-brain` last gained one in 2026-10, `drizzle-tasks` in 2026-09 |
| global `cleo.db` | `drizzle-cleo-global` (on open); `drizzle-agent-registry` (its forward migration, `store/agent-registry-store.ts`) | `drizzle-cleo-global` (newest folders through 2026-10) |
| opt-in `telemetry.db` (CLEO home, its own file and journal) | `drizzle-telemetry` (`telemetry/sqlite.ts`) | `drizzle-telemetry` |

All nine `drizzle-*` lineages are listed in `CONSOLIDATED_JOURNAL_LINEAGES`
(`packages/core/src/store/resolve-migrations-folder.ts`). Because lineages share one
`__drizzle_migrations` journal per file, each lineage's reconcile treats the others' rows as
known, never as orphans (T11829).

`drizzle-skills` is NOT run: `store/skills-db.ts` reads the `skills_*` tables that
`drizzle-cleo-global` creates, because the legacy lineage would create a bare `skills` table that
collides with the agent registry. `cleo doctor migrations` still lists `drizzle-skills` and
`drizzle-telemetry` among the global lineages it reports on (`GLOBAL_LINEAGES` in
`packages/core/src/doctor/migrations.ts`).

Schemas: `packages/core/src/store/schema/cleo-project/` and `.../cleo-global/` (the per-domain
schema files still define each domain's tables). drizzle-kit configs per lineage live in
`drizzle/<lineage>.config.ts`. `cleo doctor migrations` reports each store's journal per
lineage: applied, pending, and drift.

`scripts/new-migration.mjs` (`pnpm db:new`) scaffolds into the per-domain lineages only
(`--db tasks|brain|nexus|agent-registry|telemetry`); it has no `cleo-project` or `cleo-global`
target. In `drizzle-cleo-project` and `drizzle-cleo-global` only the consolidation folder
(`20260531000001_t11363-consolidation-cleo-project` and its global twin) carries a
`snapshot.json`; the folders after it are hand-authored `migration.sql` files. The root
`package.json` also has `pnpm db:generate:cleo-project` / `db:generate:cleo-global`, which run
drizzle-kit against those configs and then `scripts/inject-consolidation-checks.mjs`.

The canonical tree lives here at `packages/core/migrations/`. This is the **single source of
truth** for all CLEO migration SQL. Consumers (including `@cleocode/cleo`) locate migration
folders at runtime via `import.meta.resolve('@cleocode/core')` — no build-time copy or sync
step is required (ADR-054 Wave 3, T1177).

> **Historical note**: Prior to v2026.4.109 (Wave 3), a build-time copy of migration folders
> was written to `packages/cleo/migrations/` by `syncMigrationsToCleoPackage()` in
> `build.mjs` to work around `__dirname` math in the bundled CLI. This sync step was removed
> in T1180 and the `packages/cleo/migrations/` folder was deleted in T1182. Do not recreate
> that folder or the sync function.

### Core Principle (Hybrid Path A+)

`migration-manager.ts` (`reconcileJournal()` and its production patches) is the **runtime
SSoT** for journal state. `openDualScopeDb` applies each store's consolidated lineage through
the bracketed runner (`migrateBracketed` in `migration-runner.ts`); the domain store modules call
`migrateWithRetry`, which wraps `migrateSanitized`. drizzle-kit is retained as a `devDependency` for **scaffolding only**: it generates
DDL proposals that developers curate, then rename and promote to the canonical tree via
`scripts/new-migration.mjs`. drizzle-kit does NOT own the `__drizzle_migrations` journal,
does NOT gate deploys, and does NOT run at startup.

---

## Authoring a New Migration

### Step-by-step

**1. Edit the schema file.**

Modify the appropriate schema TypeScript file for your DB (see table above). Use
drizzle-orm column builders — `sqliteTable`, `text`, `integer`, `index`, etc. For partial
indexes, use `.where()` on `IndexBuilder` (see [Partial Indexes](#partial-indexes) below).

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
  (brain FK-off blocks require human review before production apply — see ADR-054 R3 §3.2).
- No trailing `--> statement-breakpoint` (the generator strips these, but verify).

**5. Commit with a task-linked message.**

```bash
git add packages/core/migrations/drizzle-<db>/<timestamp>_tNNNN-<slug>/
git commit -m "feat(TNNNN): <description> migration"
```

Or use `--commit` flag on the generator to auto-commit after the linter passes.

### Migration folder anatomy

```
packages/core/migrations/drizzle-cleo-project/
  20260531000001_t11363-consolidation-cleo-project/
    migration.sql      ← DDL applied by the runtime (readMigrationFiles reads this)
    snapshot.json      ← drizzle-kit state snapshot (advisory; NOT read at runtime)
  20261109120000_t14311-retire-ivtr-state/
    migration.sql      ← hand-authored, no snapshot
```

When drizzle-kit generates a folder, both files are committed together. `snapshot.json` is the
anchor for `drizzle-kit generate` to produce incremental diffs on the next migration — do not
delete it.

---

## Partial Indexes

Use `.where()` on `IndexBuilder` in the schema TypeScript file. The repo pins drizzle-orm
`1.0.0-rc.4`, which supports it (T1170 corrected an old comment claiming it did not).

```typescript
// packages/core/src/store/schema/cleo-project/docs.ts
index('idx_docs_attachments_type').on(table.type).where(sql`${table.type} IS NOT NULL`),
```

drizzle-kit emits the matching `CREATE INDEX ... WHERE ...` SQL when it generates the
migration.

---

## Runtime Contract

`packages/core/src/store/migration-manager.ts` is the single source of truth for migration
state at runtime. Understanding what it guarantees is essential before debugging migration
issues.

### What the reconciler does

`reconcileJournal(nativeDb, migrationsFolder, existenceTable, logSubsystem,
siblingMigrationsFolders)` runs before every migrate and handles four scenarios. The last
argument names the other lineages sharing the same journal (from
`resolveConsolidatedJournalSiblings`), so their rows are never treated as orphans:

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

Domain-module call sites use `migrateSanitized(db, { migrationsFolder })` (directly or through
`migrateWithRetry`) rather than drizzle's `migrate()`. `migrateSanitized` filters two classes of non-executable SQL
statements before they reach drizzle's `session.run()`:

1. **Whitespace-only** — produced by drizzle-kit's trailing `--> statement-breakpoint`
   marker splitting.
2. **Comment-only** — the T1165 baseline marker pattern (`migration.sql` containing only
   SQL comments).

This is a defence-in-depth layer. The generator already strips trailing breakpoints at
authoring time; `migrateSanitized` catches any that slip through.

### Accumulated patches

The reconciler carries these original production patches. All are still in
`migration-manager.ts`; removing any causes hard failures on existing installations.

| Patch | Task | Edge case handled |
|-------|------|-------------------|
| Orphaned hash reconciliation | T632 | Hash algorithm changed across Drizzle v0→v1; old DBs had stale journal entries |
| Partial application handling | T920 | Multi-statement migrations crash mid-execution, leaving partially-applied state |
| Rename-via-drop+create detection | T1135 | `RENAME TO` migration idiom bypassed the column-add probe loop |
| Drizzle v1 beta name-field backfill | T1137 | Pre-v1-beta code did not write the `name` column; `null` names caused re-runs |
| Bootstrap baseline for orphaned tables | T1141 | Tables existing without a journal required probe-and-mark-applied on first run |
| SQLITE_BUSY exponential backoff | T5185 | Parallel CLI invocations on the same DB race on the SQLite write lock |

Later safeguards in the same path:

- **Shared-journal siblings (T11829):** an entry is an orphan only when its hash belongs to no
  lineage sharing the file (see `siblingMigrationsFolders` above).
- **Worktree build guard (T12687):** a worktree build with pending migrations fails fast
  instead of touching the journal of a store outside its worktree
  (`assertNoPendingMigrationsForWorktreeBuild`, `store/worktree-build-guard.ts`).
- **`-- cleo:probe-never-stamp` (T12819):** a migration carrying this marker line is never
  probe-stamped as applied; it always runs, so it must be idempotent. Use it for a migration that
  rewrites objects that already exist (for example, replacing triggers).

### Retired: signaldock

`signaldock.db` and its bespoke embedded runner are retired. Its tables moved into the global
`cleo.db` as the `agent_registry_*` tables, renamed and maintained by `drizzle-cleo-global`
(`20260602000001_t11622-agent-registry-rename`); put new agent-registry changes there. The
`drizzle-agent-registry` lineage only carries the legacy bare-shape schema
(`agent-registry-schema.ts`) and its forward migration. There is no `drizzle-signaldock/` folder
or `signaldock-schema.ts` any more.

### sync-journal: not a drizzle lineage

`sync-journal/` holds the change journal's own tables (`_sync_meta`, `_sync_clock`,
`_sync_replica`; T12342). It is NOT a drizzle lineage: `migration-manager.ts`, drizzle-kit,
`pnpm db:new` and `scripts/lint-migrations.mjs` (which scans `drizzle-*` sets only) never touch
it. `packages/core/src/store/sync/schema.ts` applies its folders lazily, only when a `sync.*`
flag is first enabled on a store, so a store with every flag off gains no table and no journal
row. Each applied folder is journaled in `_sync_meta` as `schema:<folder>` with the sha256 of
its `migration.sql`, never in `__drizzle_migrations`; an applied folder whose SQL changed is
refused with `E_SYNC_SCHEMA_HASH_DRIFT`. Never edit an applied folder: add a new one, with the
same `YYYYMMDDHHMMSS_tNNNN-<slug>/migration.sql` naming.

---

## Linter Rules

`scripts/lint-migrations.mjs` runs automatically at the end of every `pnpm db:new`
invocation, and CI runs it with `--fail-on=error` as the `Migration Lint` step of the
`Repo Lints` job (`.github/workflows/ci.yml`). The same job runs `pnpm db:check`
(drizzle-kit check for the tasks, brain, nexus, agent-registry and telemetry configs).

Run manually:

```bash
node scripts/lint-migrations.mjs
```

With options:

```bash
node scripts/lint-migrations.mjs --migrations-root packages/core/migrations
node scripts/lint-migrations.mjs --fail-on=warn    # exit 1 on any violation
node scripts/lint-migrations.mjs --fail-on=none    # report-only, always exit 0
node scripts/lint-migrations.mjs --disable-rule-5  # emergency bypass of RULE-5 (warns)
```

### RULE-1 (ERROR): No trailing `--> statement-breakpoint`

A `migration.sql` file MUST NOT end with `--> statement-breakpoint` followed by only
whitespace. This marker is a drizzle-kit hint for its own runner; it signals that the last
SQL statement was never written. The generator strips it automatically; the linter enforces
it in CI.

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
as WARN.

### RULE-5 (ERROR): Missing statement breakpoints

A multi-statement `migration.sql` needs a `--> statement-breakpoint` between each pair of
statements: `node:sqlite` `prepare()` silently runs only the first statement otherwise (T9163).

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
| Editing or deleting a released migration; non-deterministic DML (`datetime('now')`, `random()`); a table rebuild that deletes from or re-keys an FK parent; an owned guard/side-effect `CREATE TRIGGER` without its `cleo_trigger_suspend` clause | Breaks the change journal and sync (gate 36, `scripts/lint-sync-schema.mjs`; rules in AGENTS.md) | Add a new forward migration that follows gate 36 |

---

## Adding a New DB Set

Follow these steps when introducing a new lineage. Since the consolidation, new tables normally go into `drizzle-cleo-project` or `drizzle-cleo-global` instead of a new database.

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

Add a migration smoke test in `packages/core/src/store/__tests__/migration-smoke.test.ts`
verifying that the migration applies cleanly to a fresh in-memory SQLite DB.

**7. Update CI.**

Add the new DB to the `db:check` script loop in root `package.json`. Verify the
`Migration Lint` CI step scans the new `drizzle-<db>/` folder (it scans every `drizzle-*` set
under `packages/core/migrations`), and add the lineage to `CONSOLIDATED_JOURNAL_LINEAGES` and to
`PROJECT_LINEAGES` / `GLOBAL_LINEAGES` in `packages/core/src/doctor/migrations.ts` if it shares a
`cleo.db`.

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
has not self-healed (observable via `cleo doctor migrations`):

**Step 1 — Take a backup before touching anything.**

```bash
cleo backup add
```

**Step 2 — Inspect the journal.**

```bash
cleo doctor migrations
```

It reads each store's journal (project and global `cleo.db`) as a read-only snapshot and reports,
per lineage, the applied and pending files and any hash drift. Do not open `.cleo/tasks.db`: it is
a legacy decoy, not the live store.

**Step 3 — Identify the offending migration.**

Compare journal entries against `packages/core/migrations/drizzle-<db>/` folder names. A
folder with no matching journal row is the candidate.

**Step 4 — Let the reconciler retry.**

Run any `cleo` command again: every open reconciles the journal, so Scenario 3 gets another
attempt. Do not hand-edit `__drizzle_migrations` or open `.cleo/*.db` directly.

**Step 5 — Verify with `cleo doctor`.**

```bash
cleo doctor
cleo doctor migrations
```

If the DB passes doctor checks, the recovery is complete. If the store itself is damaged
(corruption rather than a journal gap), `cleo doctor repair-store --dry-run`, then
`cleo doctor repair-store`, repairs `cleo.db` losslessly, keeping the originals and a recovery
receipt.

**Step 6 — File a bug.**

If the reconciler did not self-heal a partial migration, file a bug with:
- The migration name and the set of columns that were/were not present.
- The CLEO version (`cleo version`).
- The full output of `cleo doctor migrations`.

---

## References

### Decision records

- [`docs/adr/adr-054-migration-system-hybrid-path-a-plus.md`](../../../docs/adr/adr-054-migration-system-hybrid-path-a-plus.md) — canonical governance contract (supersedes ADR-012, ADR-027 §2.6)
- [`docs/adr/adr-051-programmatic-gate-integrity.md`](../../../docs/adr/adr-051-programmatic-gate-integrity.md) — evidence-based verify; informs the linter/guard/generator triad
- [`docs/adr/adr-012-drizzle-kit-migration-system.md`](../../../docs/adr/adr-012-drizzle-kit-migration-system.md) — original drizzle-kit adoption (superseded)

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
| T1172 | W2A-11: Author this README |
| T1173 | W2A-12: Author ADR-054 |
| T1174 | W2A-09: Adopt `.where()` for T1126 partial index via schema |

### Source files

- `packages/core/src/store/migration-manager.ts` — runtime reconciler
- `scripts/new-migration.mjs` — generator wrapper (T1164)
- `scripts/lint-migrations.mjs` — migration linter (T1168)
- `drizzle/<lineage>.config.ts` — drizzle-kit configs, one per lineage (`cleo-project`,
  `cleo-global`, `tasks`, `brain`, `nexus`, `conduit`, `agent-registry`, `skills`, `telemetry`)
- `packages/core/src/store/dual-scope-db.ts` — `openDualScopeDb`, the store chokepoint that migrates each `cleo.db`
- `packages/core/src/store/migration-runner.ts` — the bracketed per-file migration runner
- `packages/core/src/doctor/migrations.ts` — `cleo doctor migrations` and the lineage lists
- `packages/core/src/store/resolve-migrations-folder.ts` — folder resolution and `CONSOLIDATED_JOURNAL_LINEAGES`
- `packages/core/src/store/sync/schema.ts` — the `sync-journal/` applier

---

Last updated: 2026-11-15
