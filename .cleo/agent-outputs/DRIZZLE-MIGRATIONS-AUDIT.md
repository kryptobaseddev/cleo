# Drizzle Migrations Audit

**Date**: 2026-04-20
**Branch**: main (read-only, D019)
**Investigator**: DRIZZLE-AUDIT subagent

---

## Section 1: File-by-File Inventory of Both Folders

### packages/cleo/migrations/ (3 subdirectories)

```
drizzle-brain/
  20260318205549_initial/
  20260321000001_t033-brain-indexes/
  20260408000001_t417-agent-field/
  20260411000001_t528-graph-schema-expansion/
  20260412000001_t531-quality-score-typed-tables/
  20260413000001_t549-tiered-typed-memory/
  20260415000001_t626-normalize-co-retrieved-edge-type/
  20260416000001_t673-retrieval-log-plasticity-columns/
  20260416000002_t673-plasticity-events-expand/
  20260416000003_t673-page-edges-plasticity-columns/
  20260416000004_t673-new-plasticity-tables/
  20260416000005_t726-dedup-tier-columns/
  20260416000006_t790-hebbian-prune/
  20260416000007_t799-observation-attachments-json/

drizzle-nexus/
  20260318205558_initial/
  20260412000001_t529-nexus-graph-tables/
  20260415000001_t622-project-registry-paths/
  20260419000001_t998-nexus-plasticity/

drizzle-tasks/
  20260318205539_initial/
  20260320013731_wave0-schema-hardening/
  20260320020000_agent-dimension/
  20260321000000_t033-connection-health/
  20260321000002_t060-pipeline-stage-binding/
  20260324000000_assignee-column/
  20260327000000_agent-credentials/
  20260416000000_t796-attachments/
  20260416000001_t811-ivtr-state/
  20260417000000_t877-pipeline-stage-invariants/
  20260417220000_t889-playbook-tables/
  20260418174314_t944-role-scope-severity/
  20260421000001_t1126-sentient-proposal-index/
```

Total in packages/cleo/migrations/: 3 DB sets, no drizzle-signaldock, no drizzle-telemetry.

---

### packages/core/migrations/ (5 subdirectories)

```
drizzle-brain/      (identical content to packages/cleo/migrations/drizzle-brain/)
drizzle-nexus/      (identical content to packages/cleo/migrations/drizzle-nexus/)
drizzle-tasks/      (identical content to packages/cleo/migrations/drizzle-tasks/)

drizzle-signaldock/
  2026-04-17-213120_T897_agent_registry_v3.sql   (NOT in cleo package — different naming format)

drizzle-telemetry/
  20260415000001_t624-initial/   (NOT in cleo package)
```

Total in packages/core/migrations/: 5 DB sets. The 3 overlapping sets (brain, nexus, tasks) have
IDENTICAL file content verified by diff — they are not independently maintained.

---

### Third Migration Tree: drizzle/ (repo root)

A third, OLDER migration tree exists at `drizzle/migrations/`:

```
drizzle/migrations/drizzle-brain/
  20260318205549_initial/
  20260419004313_t945-graph-expansion/    <-- unique, NOT in either package folder

drizzle/migrations/drizzle-nexus/
  20260318205558_initial/

drizzle/migrations/drizzle-tasks/
  20260318205539_initial/
  20260320013731_wave0-schema-hardening/
  20260320025000_add-assignee-column/     <-- different timestamp than cleo/core
  20260416035743_complex_vampiro/         <-- auto-generated drizzle-kit name
  20260418174314_t944-role-scope-severity/
  20260421053413_melted_wind_dancer/      <-- auto-generated drizzle-kit name
```

This root-level folder has drizzle.config.ts files that point `out:` here. It appears to be the
artifact of running `drizzle-kit generate` interactively. The auto-generated names
("complex_vampiro", "melted_wind_dancer") confirm this is NOT the authoritative migration source —
it is a local dev scratch pad. The authoritative migrations are in packages/core/migrations/.

### lafs/migrations/

`packages/lafs/migrations/` contains a single file: `1.0.0-to-1.1.0.json`. This is NOT a drizzle
migration — it is a JSON schema version migration descriptor specific to the LAFS envelope format.
Entirely separate concern.

---

## Section 2: drizzle.config.ts Files Found + Schema/Out Mappings

Three config files found, all at `drizzle/` (repo root):

| File | schema: | out: | dialect |
|------|---------|------|---------|
| `drizzle/brain.config.ts` | `packages/core/src/store/brain-schema.ts` | `drizzle/migrations/drizzle-brain` | sqlite |
| `drizzle/nexus.config.ts` | `packages/core/src/store/nexus-schema.ts` | `drizzle/migrations/drizzle-nexus` | sqlite |
| `drizzle/tasks.config.ts` | `packages/core/src/store/tasks-schema.ts` | `drizzle/migrations/drizzle-tasks` | sqlite |

Critical observation: these configs output to `drizzle/migrations/` (the scratch pad), NOT to
`packages/core/migrations/` where the authoritative migrations live. This means running
`drizzle-kit generate` with these configs produces output in the wrong location. The authoritative
migrations in `packages/core/migrations/` appear to be committed directly with manually curated
names (e.g., `t033-brain-indexes`, `t549-tiered-typed-memory`) rather than drizzle-kit output.

No drizzle.config.ts exists for `drizzle-signaldock` or `drizzle-telemetry`.

---

## Section 3: Invocation Sites (Who Calls migrate, from What Code Path)

All migration runners live in `packages/core/src/`. There are zero migration runners in
`packages/cleo/src/` — the CLI package never calls `migrate()` directly.

### tasks.db (sqlite.ts)
- `resolveMigrationsFolder()` in `packages/core/src/store/sqlite.ts`
- Resolution logic: `isBundled ? join(__dirname, '..') : join(__dirname, '..', '..')`
- From source (`src/store/`): resolves to `packages/core/migrations/drizzle-tasks`
- From bundle (`dist/`): resolves to `dist/../migrations/drizzle-tasks` — i.e., **`packages/cleo/migrations/drizzle-tasks`** when bundled into the cleo package

### brain.db (memory-sqlite.ts)
- `resolveBrainMigrationsFolder()` in `packages/core/src/store/memory-sqlite.ts`
- Same two-path logic: `packages/core/migrations/drizzle-brain` (source) vs **`packages/cleo/migrations/drizzle-brain`** (bundled)

### nexus.db (nexus-sqlite.ts)
- `resolveNexusMigrationsFolder()` in `packages/core/src/store/nexus-sqlite.ts`
- Different approach: walks up 8 levels searching for `migrations/drizzle-nexus` via `existsSync()`
- Finds whichever `migrations/drizzle-nexus` directory is present first in the walk

### telemetry.db (telemetry/sqlite.ts)
- `resolveTelemetryMigrationsFolder()` in `packages/core/src/telemetry/sqlite.ts`
- Same two-path logic: resolves to `packages/core/migrations/drizzle-telemetry`
- NOT synced to packages/cleo — telemetry is core-only, not CLI-exposed

### signaldock.db (migration-sqlite.ts)
- Imports `resolveMigrationsFolder` from `sqlite.ts` (which resolves drizzle-tasks)
- The signaldock migration file in `packages/core/migrations/drizzle-signaldock/` uses a different
  format (no subdirectory, bare SQL file) and appears to be a manual bootstrap, not drizzle-kit output

---

## Section 4: Exact drizzle-orm and drizzle-kit Versions

### Declared in package.json

| Package | drizzle-orm | drizzle-kit |
|---------|-------------|-------------|
| packages/core/package.json | `1.0.0-beta.22-ec7b61d` | not declared |
| packages/nexus/package.json | `1.0.0-beta.22-ec7b61d` | not declared |
| packages/playbooks/package.json | `1.0.0-beta.22-ec7b61d` | not declared |
| root package.json | not declared | `1.0.0-beta.19-d95b7a4` |

### Locked in pnpm-lock.yaml

```
drizzle-orm@1.0.0-beta.22-ec7b61d   (locked, matches declared)
drizzle-kit@1.0.0-beta.19-d95b7a4   (locked, matches declared)
```

**Verdict**: Owner memory is confirmed. Both packages are on the v1.0.0-beta line:
- `drizzle-orm`: `1.0.0-beta.22-ec7b61d` (more recent beta than drizzle-kit)
- `drizzle-kit`: `1.0.0-beta.19-d95b7a4`

These are pre-release beta builds with commit hash suffixes, not the generic `1.0.0-beta`
string. They are pinned exactly and must not be downgraded to 0.x.

---

## Section 5: Duplication Verdict

**The split is architecturally JUSTIFIED but operationally confusing.**

Here is the precise mechanism that explains why both folders must exist:

### The Core Problem: Bundle Resolution

When esbuild bundles `packages/core/src/` into `packages/cleo/dist/cli/index.js`, the bundled
code runs with `__dirname === packages/cleo/dist/`. The `resolveMigrationsFolder()` function
detects this (`isBundled = true`) and resolves migrations to:

```
packages/cleo/dist/../migrations/  →  packages/cleo/migrations/
```

At runtime on a user's machine after `npm install @cleocode/cleo`, only the `@cleocode/cleo`
package directory exists in node_modules. The `@cleocode/core` package is a peer dependency but
its `migrations/` folder is what actually contains the source of truth. The bundled CLI cannot
reach across package boundaries to `@cleocode/core/migrations/` — it must find them relative to
its own package root.

### The Sync Mechanism

This is why `build.mjs` implements `syncMigrationsToCleoPackage()` (added in T759):

1. Source of truth: `packages/core/migrations/{drizzle-brain,drizzle-nexus,drizzle-tasks}`
2. Build step copies all subdirectories from core to cleo (additive, never deletes)
3. The cleo package then ships its own `migrations/` that is a synchronized copy

The task T759 was filed because T528's brain migration was absent from cleo's copy, causing the
`E_BRAIN_OBSERVE: no such column: provenance` production bug on v2026.4.65.

### Why drizzle-signaldock and drizzle-telemetry are NOT in cleo

These two DB schemas are NOT synced because:
- `drizzle-telemetry`: telemetry.db is managed by `packages/core/src/telemetry/` only, never via CLI
- `drizzle-signaldock`: the signaldock migration is a manual SQL file (not drizzle-kit format) and
  appears to be applied separately

### Content Comparison

Running `diff` across all matching migration files: **ZERO differences found.** Every file that
exists in both packages is byte-for-byte identical. The cleo package files are purely a build
artifact copy.

### The Three Trees in Summary

| Location | Purpose | Authoritative? | Used at runtime? |
|----------|---------|----------------|------------------|
| `packages/core/migrations/` | Source of truth for all migrations | YES | YES (dev/source mode) |
| `packages/cleo/migrations/` | Synced copy for CLI bundle distribution | NO (copy) | YES (bundled CLI) |
| `drizzle/migrations/` | Scratch pad from `drizzle-kit generate` | NO | NO |

---

## Section 6: Recommendation

### Keep the split — it is load-bearing. Do NOT merge.

The split between `packages/core/migrations/` and `packages/cleo/migrations/` is not duplication
in the DRY sense. They serve two distinct runtime contexts:

1. `packages/core/migrations/` is the canonical schema history, edited by developers, used in
   dev/test (source mode via `tsx`).
2. `packages/cleo/migrations/` is a build artifact that enables the published `@cleocode/cleo`
   npm package to ship migrations without requiring consumers to also install `@cleocode/core`
   separately.

### Action items (not duplicates — these are real gaps):

1. **Fix the drizzle.config.ts `out:` paths.** The three configs in `drizzle/` point to
   `drizzle/migrations/` instead of `packages/core/migrations/`. Running `drizzle-kit generate`
   produces output in the wrong location with auto-generated names. The configs should be updated
   to point to `packages/core/migrations/drizzle-{brain,nexus,tasks}` respectively, or the
   `drizzle/migrations/` scratch pad should be deleted to prevent confusion.

2. **The `drizzle/migrations/` tree should be removed or gitignored.** It is stale, partially
   diverged (different timestamps, auto-generated names), and not used at runtime. Leaving it
   creates the illusion of a third migration source.

3. **Document the sync contract.** A comment near `syncMigrationsToCleoPackage()` already exists
   but `packages/cleo/migrations/README.md` or a comment at the top of each sub-folder should
   state: "DO NOT EDIT — auto-synced from packages/core/migrations/ during build." This prevents
   future agents from editing the copy instead of the source.

4. **Telemetry and signaldock migration ownership needs cleanup.** `drizzle-signaldock` uses a
   non-drizzle-kit file format (bare SQL, no `meta/_journal.json`). Verify it is applied
   correctly at runtime and consider migrating to standard drizzle-kit format.
