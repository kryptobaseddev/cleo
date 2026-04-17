# Lead 2 Architecture — Registry SSoT (T889)

> Research-phase doc for T897, T898, T899, T900, T901, T906.
> SSoT: `$XDG_DATA_HOME/cleo/signaldock.db:agents` + `.agent_skills`.
> Filesystem = transport for install/doctor only. Spawn MUST NOT fs-scan.

---

## 1. FINAL-STATE ARCHITECTURE

### 1.1 Canonical storage layout

| Layer | Location | Owner | Role |
|---|---|---|---|
| Global identity | `$XDG_DATA_HOME/cleo/signaldock.db:agents` | Lead 2 | canonical per-machine agent identity |
| Global skills junction | `signaldock.db:agent_skills` | Lead 2 + Lead 4 | agent ↔ skill bindings |
| Global capabilities junction | `signaldock.db:agent_capabilities` | Lead 2 | agent ↔ capability bindings |
| Global `.cant` files (transport) | `$XDG_DATA_HOME/cleo/cant/agents/<agentId>/persona.cant` | Lead 2 (install) | source-of-truth file for install; content hash tracked in DB |
| Project attachment | `.cleo/conduit.db:project_agent_refs` | Lead 2 | per-project enable/disable + role override |
| Project `.cant` overrides | `.cleo/cant/agents/<agentId>/persona.cant` | Lead 2 (install) | project-tier overrides; override-by-basename |
| Built-in packaged | `@cleocode/agents/seed-agents/*.cant` | Lead 1 | immutable seed source shipped with the package |
| Runtime fallback | hard-coded `AgentHierarchyEntry` map in `hierarchy.ts` | Lead 1/2 | final fallback when DB is cold |

### 1.2 New columns required (migration `20260417_T897_agent_registry_v3.sql`)

Additive only — never drop, never change existing types. Values default to safe nulls so existing rows continue to work.

```sql
-- signaldock.db.agents — new columns (all nullable, defaults safe)
ALTER TABLE agents ADD COLUMN tier TEXT NOT NULL DEFAULT 'global';        -- global | project | packaged | fallback
ALTER TABLE agents ADD COLUMN can_spawn INTEGER NOT NULL DEFAULT 0;      -- AgentHierarchyEntry.canSpawn mirror
ALTER TABLE agents ADD COLUMN orch_level INTEGER;                         -- OrchestrationLevel enum (0-4) nullable
ALTER TABLE agents ADD COLUMN reports_to TEXT;                            -- agentId of superior; soft-FK
ALTER TABLE agents ADD COLUMN cant_path TEXT;                             -- absolute path to persona.cant at install time
ALTER TABLE agents ADD COLUMN cant_sha256 TEXT;                           -- sha256 of persona.cant bytes at install time
ALTER TABLE agents ADD COLUMN installed_from TEXT;                        -- 'seed' | 'cantz' | 'dir' | 'cloud' | 'legacy'
ALTER TABLE agents ADD COLUMN installed_at INTEGER;                       -- unix seconds
CREATE INDEX IF NOT EXISTS agents_tier_idx ON agents(tier);
CREATE INDEX IF NOT EXISTS agents_can_spawn_idx ON agents(can_spawn) WHERE can_spawn = 1;
CREATE INDEX IF NOT EXISTS agents_installed_from_idx ON agents(installed_from);

-- agent_skills — declared-vs-effective rigor (nullable → back-compat with the 0 rows today)
ALTER TABLE agent_skills ADD COLUMN source TEXT NOT NULL DEFAULT 'cant';  -- 'cant' | 'manual' | 'computed'
ALTER TABLE agent_skills ADD COLUMN attached_at INTEGER NOT NULL DEFAULT (strftime('%s','now'));
```

`AgentCredential` contract grows two fields:
```ts
tier: 'global' | 'project' | 'packaged' | 'fallback';
canSpawn: boolean;
```

### 1.3 New accessor surface (extends `agent-registry-accessor.ts`)

```ts
/** Deterministic tier precedence: project ref > global agent > packaged seed > hard-coded fallback. */
export type AgentTier = 'project' | 'global' | 'packaged' | 'fallback';

/** Single resolve — the hot path spawn MUST use. Zero fs-scan. */
export function resolveAgent(
  projectRoot: string,
  agentId: string,
  opts?: { preferTier?: AgentTier; requireSpawnable?: boolean },
): ResolvedAgent | null;

/** Skills declared for an agent (SSoT for adapter enrichment). */
export function getAgentSkills(
  projectRoot: string,
  agentId: string,
): Array<{ slug: string; name: string; category: string; source: string }>;

/** Bulk resolution for spawn + classify — one DB roundtrip instead of N. */
export function resolveAgentsBatch(
  projectRoot: string,
  agentIds: string[],
  opts?: { requireSpawnable?: boolean },
): Map<string, ResolvedAgent>;

/** Install pipeline — single atomic unit. */
export function installAgentFromCant(params: {
  cantPath: string;              // absolute path to persona.cant
  targetTier: 'global' | 'project';
  projectRoot: string;
  installedFrom: 'seed' | 'cantz' | 'dir' | 'cloud';
  overwrite?: boolean;           // default false — idempotent re-install is allowed
}): InstallResult;

/** Doctor report builder — pure read, no mutation. */
export function buildDoctorReport(projectRoot: string): DoctorReport;

/** Doctor reconcile — optional --fix mode; strictly additive operations. */
export function reconcileDoctor(projectRoot: string, report: DoctorReport, opts: {
  fix?: boolean; dryRun?: boolean;
}): ReconcileResult;
```

`ResolvedAgent` = `AgentCredential + { tier, canSpawn, orchLevel, reportsTo, cantPath, cantSha256, skills }`.

### 1.4 Precedence order (resolveAgent)

Deterministic, tested in its own spec:

1. **project tier** — `project_agent_refs.enabled = 1` row exists → merge with global identity → return `tier: 'project'`
2. **global tier** — global `agents` row exists without project ref (or `enabled = 0` when `preferTier != 'project'`) → return `tier: 'global'`
3. **packaged tier** — no DB row exists BUT `@cleocode/agents/seed-agents/<agentId>.cant` ships with the install → on first access, auto-install from seed (idempotent), then re-resolve as `tier: 'global'`. This path is taken at most once per `agentId` per machine (guarded by a `SELECT id WHERE agent_id = ?` probe).
4. **fallback tier** — `hierarchy.ts buildDefaultHierarchy()` entry exists → synthesize a minimal `ResolvedAgent` with `canSpawn` from that map and `tier: 'fallback'`. Emits a WARN log once per agentId per process.

`preferTier` biases the scan start; `requireSpawnable` filters on `canSpawn = 1`.

### 1.5 Install pipeline (`installAgentFromCant`)

All five steps run in a single SQLite transaction on `signaldock.db` (the conduit write for project-tier install is the second, separate transaction).

```
1. VALIDATE       parse persona.cant via @cleocode/cant parser (or fallback regex for legacy);
                  extract agentId, name, class, skills[], capabilities[], orch-level hints
2. CHECKSUM       sha256(fileBytes) → cantSha256
3. TARGET COPY    cpSync(source.cant, target.cant) with mkdirp; target =
                    global → $XDG_DATA_HOME/cleo/cant/agents/<agentId>/persona.cant
                    project → <projectRoot>/.cleo/cant/agents/<agentId>/persona.cant
                  (same file layout cleo-cant-bridge already scans; continues working)
4. DB WRITE       INSERT OR REPLACE INTO agents (tier=<targetTier>, cant_path=?, cant_sha256=?, can_spawn=?, orch_level=?, ...)
                  DELETE FROM agent_skills WHERE agent_id=?;
                  INSERT INTO agent_skills (agent_id, skill_id, source='cant', attached_at=?) SELECT agent_uuid, skills.id FROM skills WHERE skills.slug IN (?)
                  (skills NOT in the catalog are surfaced to the INSTALL report — NOT inserted; no silent drops)
                  INSERT INTO agent_capabilities (agent_id, capability_id) similarly
5. PROJECT ATTACH if targetTier='project' OR --attach flag, also INSERT INTO .cleo/conduit.db:project_agent_refs (enabled=1)
                  (uses existing attachAgentToProject — no new code)
```

Returns `{ agentId, tier, cantPath, cantSha256, skillsAttached: [], skillsUnknown: [], rowsWritten: n }`. Unknown skills are a soft warning by default, a hard error under `--strict`.

### 1.6 Attach/detach semantics (clarified)

Today: `cleo agent attach <id>` toggles `.cleo/conduit.db:project_agent_refs.enabled`. Spawn ignores this. Post-T900:

| State | Behavior |
|---|---|
| no project_agent_refs row | spawn MUST skip the agent unless `preferTier = 'global'` |
| enabled = 1 | eligible as project-tier resolution target |
| enabled = 0 | ineligible; doctor surfaces a "detached" note (not a warning) |
| global row missing + ref present | doctor raises `E_DANGLING_REF` |

Spawn adapter (`buildCantEnrichedPrompt`) queries `resolveAgent(projectRoot, agentId, { requireSpawnable: true })` and uses the returned `cantPath` to load the persona bytes directly — no `readdirSync` in the hot path.

### 1.7 Doctor check list (T901)

`cleo agent doctor` runs these checks; all are read-only; `--fix` applies additive fixes only.

| Check | What | Suggested fix |
|---|---|---|
| `D-001` orphan-cant-file | `.cant` file exists on disk, no DB row | `cleo agent install <path>` |
| `D-002` orphan-row | DB row exists, `cant_path` points to missing file | `cleo agent install --from-db <agentId>` (rehydrate from packaged seed if available) |
| `D-003` checksum-mismatch | `cant_path` file sha256 ≠ `cant_sha256` | notify operator (edit is legitimate but audit); `--fix` rewrites `cant_sha256` |
| `D-004` unattached-global | global agent has no project ref anywhere | informational only; no fix |
| `D-005` dangling-ref | `project_agent_refs` points to missing global row | `cleo agent remove <agentId>` (confirmed destructive) |
| `D-006` skill-drift | `.cant.skills[]` declaration ≠ `agent_skills` junction rows | `cleo agent install --resync <agentId>` (re-parses + re-writes junction) |
| `D-007` unknown-skills | `.cant` declares skills not in `skills` catalog | operator must register the skill catalog entry first, then re-resync |
| `D-008` tier-mismatch | `agents.tier` column ≠ actual cant_path location | `--fix` corrects the tier column based on path |
| `D-009` duplicate-id | same `agent_id` declared by multiple `.cant` files across tiers | informational — override semantics still apply but operator should pick one |
| `D-010` legacy-json-registry | `~/.cleo/agent-registry.json` exists | one-shot migrate into `signaldock.db` then rename to `.bak` |

---

## 2. CURRENT-STATE FINDINGS

### 2.1 Live DB schema (actual, this machine)

```sql
-- signaldock.db.agents (VERIFIED via .schema):
-- 34 columns incl. id, agent_id, name, class, privacy_tier, capabilities (JSON TEXT),
-- skills (JSON TEXT), transport_*, api_*, classification, is_active, last_used_at,
-- requires_reauth. No tier, no can_spawn, no cant_path, no cant_sha256, no orch_level.
-- Unique index on agent_id. Junction tables exist but are EMPTY.

CREATE TABLE agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id),   -- <— references agents.id (UUID), NOT agents.agent_id
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (agent_id, skill_id)
);

-- Row counts right now:
--   agents = 3  (cleo-prime-dev, cleo-prime, test-worker)
--   skills = 36 (language + framework catalog seeded)
--   capabilities = 19 (seeded)
--   agent_skills = 0  ← JUNCTION TABLE IS EMPTY FOR EVERY AGENT
--   project_agent_refs = 2 (cleo-prime-dev, cleo-prime) in local conduit.db
```

**The agent_skills junction is the SSoT Lead 4 is writing to, but no row has ever been inserted for a real agent.** `syncJunctionTables()` in agent-registry-accessor.ts:263-292 exists and is wired — but `createProjectAgent` is never called with a non-empty skills array because `cleo agent install` hard-codes `skills: []` at line 2158. So the junction is necessarily empty.

### 2.2 Existing accessor methods (agent-registry-accessor.ts)

| Method | Status | Gap |
|---|---|---|
| `lookupAgent(projectRoot, agentId, { includeGlobal? })` | Solid | returns `AgentWithProjectOverride`, no tier field, no canSpawn, no cantPath. Needs a `resolveAgent` wrapper that adds these. |
| `listAgentsForProject(projectRoot, { includeGlobal?, includeDisabled? })` | Solid | ditto — needs batch resolve variant. |
| `createProjectAgent(projectRoot, spec)` | Solid | no `cantPath`/`cantSha256` capture; junction sync happens but with empty arrays because callers don't supply skills. |
| `attachAgentToProject/detachAgentFromProject` | Solid | idempotent, good — spawn just needs to honor them. |
| `AgentRegistryAccessor.register()` | Solid wrapper | same gaps as `createProjectAgent`. |
| `syncJunctionTables(db, agentUuid, caps, skills)` | Solid | ready for use — just needs callers to pass real data. |
| `getAgentSkills(agentId)` | **MISSING** | Lead 4 needs this to enrich spawn prompts. |
| `resolveAgent(projectRoot, agentId, {preferTier})` | **MISSING** | spawn hot path needs this. |
| Doctor | **MISSING** | no report, no reconcile. |

### 2.3 How `cleo agent install` currently writes rows

`packages/cleo/src/cli/commands/agent.ts:2136-2167`:
- Copies `.cant` file into target tier correctly.
- THEN does a **best-effort** registry write: `registry.register({ agentId: agentName, displayName, apiKey: 'local-installed', ... skills: [], capabilities: [], isActive: false })`.
- `skills: []` is hardcoded — the junction stays empty.
- `cantPath`, `cantSha256`, `tier` columns don't exist yet, so no durable link between file and row.
- Errors are swallowed (`catch {}` on line 2165) — a "successful install" can leave DB with no row at all, which is exactly the orphan state we see in `.cleo/agents/` today (6 `.cant` files, 2 rows).

### 2.4 Where spawn SHOULD call registry but doesn't

Concrete file:line map for Lead 3's consumption:

| File:line | Current | Should become |
|---|---|---|
| `packages/adapters/src/cant-context.ts:870-910` `buildCantEnrichedPrompt` | calls `discoverCantFilesMultiTier(projectDir)` → fs-scan across 3 tiers | calls `resolveAgent(projectRoot, agentName, { requireSpawnable: true })` to get `cantPath`, then reads that single file. Legacy fs-scan kept as a doctor-path fallback only. |
| `packages/adapters/src/cant-context.ts:161-175` `discoverCantFiles` | recursive `readdirSync` | kept for doctor, NEVER for spawn |
| `packages/cleo/src/dispatch/domains/orchestrate.ts:672-732` `orchestrateClassify` | reads `.cant` files via `readdirSync` from `getCleoCantWorkflowsDir()` AND from `<projectRoot>/.cleo/workflows` | queries `listAgentsForProject(projectRoot, { includeGlobal: true })` + filters `canSpawn=1` — no fs-scan |
| `packages/core/src/skills/agents/install.ts:97-114` `installAllAgents` | scans `getAgentsDir()` | replaced by `installAgentFromCant` from packaged seed list |
| `packages/core/src/skills/agents/registry.ts` (entire file — `~/.cleo/agent-registry.json`) | duplicate JSON registry | deprecated; migrate to `signaldock.db` then delete (D-010 doctor check) |
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts:582` `agentDef` pass-through | always undefined today (nothing sets it on `SpawnContext`) | populated from `resolveAgent(...)` before the adapter dispatch |

---

## 3. ATOMIC WORKER TASKS

Decomposition of T897, T898, T899, T900, T901, T906 into 12 workers. Each ≤3 files, ≤200 LOC, AC = lines of output the worker produces + a test file that proves it works. All workers run on `@cleocode/core` or `@cleocode/cleo` and land with TSDoc + vitest.

| ID | Title | Files | Size | Blocks |
|---|---|---|---|---|
| W2-1 | Migration `20260417_T897_agent_registry_v3.sql` + forward-compat accessor read path | `packages/core/migrations/drizzle-signaldock/20260417_T897_agent_registry_v3.sql`, `packages/core/src/store/signaldock-sqlite.ts` (add `AGENT_REGISTRY_V3_MIGRATION_SQL` + `applyAgentRegistryV3` helper), `packages/core/src/store/agent-registry-accessor.ts` (update `AgentDbRow` + `rowToCredential` to read new columns, safe-default when null) | small | — |
| W2-2 | Extend contracts: `ResolvedAgent`, `AgentTier`, add `tier`+`canSpawn`+`cantPath`+`cantSha256` to `AgentCredential`, `AgentInstallResult`, `DoctorReport`, `DoctorCheckId` enum (D-001..D-010) | `packages/contracts/src/agent-registry.ts`, `packages/contracts/src/index.ts` | small | W2-1 |
| W2-3 | `installAgentFromCant(params)` — atomic install pipeline: validate→checksum→copy→write row→sync junctions. Uses `@cleocode/cant` parser when available, falls back to regex. Surfaces unknown skills as soft-warn. | `packages/core/src/store/agent-install.ts` (new), `packages/core/src/store/agent-registry-accessor.ts` (export) | medium | W2-1, W2-2, Lead 4 catalog seeding |
| W2-4 | `resolveAgent` + `resolveAgentsBatch` + `getAgentSkills` — tier precedence + auto-install from packaged seed fallback + hierarchy-fallback synth. In-memory 60s LRU cache keyed by `(projectRoot, agentId)` invalidated on every `install/attach/detach`. | `packages/core/src/store/agent-resolver.ts` (new), `packages/core/src/store/agent-registry-accessor.ts` (re-export) | medium | W2-1, W2-2, W2-3, Lead 1 for packaged seed path constant |
| W2-5 | Postinstall seed hook — walk `@cleocode/agents/seed-agents/*.cant`, call `installAgentFromCant({targetTier:'global', installedFrom:'seed'})` for each. Idempotent on re-install (skip when sha256 matches). | `packages/cleo/bin/postinstall.js` (extend), `packages/core/src/bootstrap.ts` (add `seedBundledAgents`) | small | W2-3, Lead 1 for canonical source dir |
| W2-6 | Rewrite `cleo agent install` to call `installAgentFromCant` (replace the best-effort `try/catch`). Keep flag surface identical; add `--strict`, `--attach`, `--resync`. | `packages/cleo/src/cli/commands/agent.ts` (lines 1977-2190) | small | W2-3 |
| W2-7 | `cleo agent doctor` command — reuses `AgentRegistryAccessor` for reads; never writes unless `--fix`. JSON envelope output. Maps each finding to a `DoctorCheckId` + a 1-line remediation. | `packages/cleo/src/cli/commands/agent.ts` (new subcommand block), `packages/core/src/store/agent-doctor.ts` (new) | medium | W2-2, W2-4 |
| W2-8 | Legacy JSON-registry migrator (D-010) — one-shot reader in `agent-doctor.ts` that reports and optionally imports `~/.cleo/agent-registry.json` rows into `signaldock.db`, then renames to `.bak`. | `packages/core/src/store/agent-doctor.ts`, delete `packages/core/src/skills/agents/registry.ts` only AFTER migration ships two minor versions | small | W2-7 |
| W2-9 | Wire `agentDef` in spawn: set `SpawnContext.agentDef` from `resolveAgent` inside `prepareSpawn` (or in `orchestrate-engine.ts` pre-dispatch). Produces `{ agentId, cantPath, skills, capabilities, orchLevel, canSpawn }` as the adapter-visible def. | `packages/core/src/orchestration/index.ts:240`, `packages/core/src/orchestration/spawn-prompt.ts`, `packages/cleo/src/dispatch/engines/orchestrate-engine.ts:530-600` | medium | W2-4 — **hands off to Lead 3** |
| W2-10 | Adapter hot-path swap: `buildCantEnrichedPrompt` takes the `agentDef.cantPath` and reads that single file; `discoverCantFilesMultiTier` becomes fallback when `agentDef` absent (legacy path). | `packages/adapters/src/cant-context.ts:870-910` | small | W2-9 — **coordinate with Lead 3** |
| W2-11 | `orchestrateClassify` swap — replace `readdirSync` with `listAgentsForProject({ includeGlobal: true })` + substring scoring over `agents.description` + `classification`. | `packages/cleo/src/dispatch/domains/orchestrate.ts:666-770` | small | W2-4 |
| W2-12 | Integration vitest matrix — fresh in-memory `signaldock.db` via `new DatabaseSync(':memory:')` + `ensureGlobalSignaldockDb`-equivalent inline schema; runs: install-from-cant, resolve by tier, doctor finds each D-code, legacy JSON migration, fresh-install cold path, upgrade path with pre-existing rows. No mocks — real SQLite. | `packages/core/src/store/__tests__/agent-install.test.ts`, `packages/core/src/store/__tests__/agent-resolver.test.ts`, `packages/core/src/store/__tests__/agent-doctor.test.ts` | medium | W2-3, W2-4, W2-7 |

Wave planning: W2-1 + W2-2 first (schema + contracts). Then W2-3 + W2-4 in parallel. Then W2-5/W2-6/W2-11 in parallel. W2-9 + W2-10 paired with Lead 3. W2-7/W2-8 paired at end. W2-12 runs last and gates the epic.

---

## 4. MIGRATION PLAN

### 4.1 Initial seed-install migration (idempotent)

Triggered by `postinstall` AND `cleo init` AND on cold-start if `SELECT COUNT(*) FROM agents WHERE tier = 'global' AND installed_from = 'seed' = 0`:

```
for file in packages/agents/seed-agents/*.cant:
  agentId = basename(file, '.cant')
  exists = SELECT id FROM agents WHERE agent_id = agentId
  if not exists OR sha256(file) != exists.cant_sha256:
    installAgentFromCant({ cantPath: file, targetTier: 'global', installedFrom: 'seed' })
```

Rollback: safe. All writes are `INSERT OR REPLACE` on `agents` + `DELETE+INSERT` on `agent_skills` scoped to the one agent. Users who hand-edited their global `.cant` file (D-003) see their sha change → migration SKIPS them (exists && sha mismatch is a user edit, not an upgrade).

### 4.2 Backfill `agent_skills` from existing `.cant` declarations

One-shot function `backfillAgentSkills(db)` run by the migration runner after schema change:

```
for row in SELECT id, agent_id, cant_path FROM agents WHERE cant_path IS NOT NULL:
  if !existsSync(row.cant_path): continue  // doctor will flag later
  parsed = parseCant(readFileSync(row.cant_path))
  syncJunctionTables(db, row.id, parsed.capabilities, parsed.skills)  // existing function
```

Existing rows without `cant_path` (the 3 live rows today) are left alone — they get a D-002 doctor finding next time `cleo agent doctor` runs. No destructive action.

### 4.3 The 4 orphan `.cant` files in `.cleo/agents/`

This directory is the OLD layout (pre-T438 3-tier) — the `cleo-cant-bridge.ts:591` now uses `.cleo/cant/agents` (note the extra `cant/` segment). So:

1. **Doctor finds them at path `.cleo/agents/*.cant`** (D-001 orphan-cant-file, with subcategory "legacy-path").
2. **`cleo agent install --from-legacy <path>`** copies the file to the new location `.cleo/cant/agents/<agentId>/persona.cant` AND writes the row. The legacy file is moved (not deleted) to `.cleo/agents/.archive/<agentId>.cant.bak`.
3. **`cleo init --migrate-legacy-agents`** automates it for all four.

No destructive action without explicit operator command. `cleo doctor --fix` does NOT auto-migrate path changes — it requires `--allow-path-migration`.

---

## 5. CROSS-LEAD DEPENDENCIES

| From | To Lead | What I need |
|---|---|---|
| W2-3 install pipeline | **Lead 1 (CANT v3)** | Stable `parseCant(source) → { agentId, name, description, skills[], capabilities[], orchLevel?, canSpawn?, reportsTo? }` signature. Fallback regex is a temporary bridge. |
| W2-3, W2-5 | **Lead 1** | Final pick for canonical seed-agents dir (I expect `packages/agents/seed-agents/`). I read its `index.ts` / `manifest.json` to know which personas to seed. |
| W2-9, W2-10 | **Lead 3 (spawn)** | Agreement that the adapter uses `agentDef.cantPath` as primary read source, with `discoverCantFilesMultiTier` as fallback. I produce the `ResolvedAgent` shape; Lead 3 consumes it. |
| W2-3, W2-12 | **Lead 4 (skills)** | Stable `skills` catalog slugs — when `.cant` declares a skill not in the catalog, I surface it as a soft-warn; Lead 4 is responsible for seeding catalog entries in `signaldock-sqlite.ts`. Also: exact `agent_skills.source` taxonomy ('cant' | 'manual' | 'computed'). |
| W2-9 | **Lead 3** | `SpawnContext.agentDef?: unknown` becomes `agentDef?: ResolvedAgent` — contract change that Lead 3's spawn-prompt renderer must tolerate. |

---

## 6. TOP 3 RISKS

**R1 — DB migration safety on mixed-version installs.**  
Existing `agents` rows lack `tier`/`cant_path` columns. If a worker builds against v3 schema but runs on a v2 DB, reads fail. Mitigation: add columns with safe defaults (`DEFAULT 'global'`, `DEFAULT NULL`) so v2 rows "just work" at read time. `rowToCredential` treats NULL `tier` as `'global'`. `ensureGlobalSignaldockDb` runs the `ALTER TABLE` block idempotently (`IF NOT EXISTS`-style via migration manager). `vacuumIntoBackupAll` already snapshots `signaldock.db` on every `session end` so any migration has a rollback window. Test explicitly with a pre-populated v2 DB fixture.

**R2 — Fresh-install dead-lock: no agents in DB, spawn needs an agent.**  
A fresh `npm install -g @cleocode/cleo` followed by immediate `cleo orchestrate spawn <taskId>` would hit the empty-DB path. Mitigation (three layers): (a) postinstall seeds from `@cleocode/agents/seed-agents/` — default state always has 6 agents; (b) `resolveAgent` tier-3 auto-installs from packaged seed on first miss (self-healing); (c) tier-4 `fallback` returns the hard-coded hierarchy entry so even a corrupt DB gives us `cleoos-opus-orchestrator` and `cleo-dev`. Never throw; always degrade.

**R3 — Upgrade path: existing users have `.cleo/agents/*.cant` (legacy location) + rows pointing nowhere + legacy JSON registry.**  
Three drift sources: (i) legacy `.cleo/agents/` files (4 on this machine), (ii) legacy `~/.cleo/agent-registry.json`, (iii) rows in `agents` without `cant_path`. Naive migration breaks in one of the three. Mitigation: `cleo agent doctor` surfaces all three as distinct D-codes (D-001 legacy-path, D-010 legacy-json, D-002 orphan-row). `--fix` requires separate flags per category (`--allow-path-migration`, `--import-legacy-json`, `--rehydrate-from-seed`). Default behavior is REPORT ONLY. Opt-in destructive migration. Test matrix in W2-12 includes all three legacy states independently and in combination.
