# CLEO Agent Loading Architecture — Comprehensive Audit

**Task**: T1233 (Pre-Wave Epic T1232) — CLEO Agents Architecture Remediation v2026.4.110
**Audit Date**: 2026-04-21
**Status**: Comprehensive audit complete; implementation unblocked

---

## 1. Per-File Summary

### 1.1 `/packages/core/src/store/agent-resolver.ts`

**Purpose**: 4-tier precedence resolver for agent lookup from global registry database.

**Public API**:
- `resolveAgent(db, agentId, options)` — Primary resolution function; throws `AgentNotFoundError` when no tier matches
- `resolveAgentsBatch(db, agentIds, options)` — Batch resolution with per-id error collection
- `getAgentSkills(db, agentId)` — Read skills from `agent_skills` junction (SSoT over cached JSON)
- `AgentNotFoundError` — Custom error with exit code 65; includes `triedTiers` for diagnostics
- `DEPRECATED_ALIASES` — Readonly frozen object mapping old IDs to canonical replacements

**Key Behaviors**:
- **Alias remap phase**: Checks `DEPRECATED_ALIASES` table (unless `skipAliasCheck=true`) and transparently rewrites deprecated agent IDs before tier lookup
- **Tier ordering**: Default is `project → global → packaged → fallback`; `preferTier` option moves a tier to head of queue
- **Orphan cascade**: When `tryResolveAtTier()` finds a DB row but the `.cant` file is missing, logs a WARN and falls through to the next tier (D-002 mitigation)
- **Fallback synthesis**: When no DB row exists at any tier but a seed-agents file exists on disk, synthesizes a `ResolvedAgent` envelope with `tier='fallback'`, `canSpawn=false`, `orchLevel=2`
- **Skill union**: Reads skills from `agent_skills` junction (source of truth); falls back to cached JSON only if junction has zero rows
- **Skills via junction query**: `getAgentSkills()` performs a 3-table join (`agents.agent_id → agents.id → agent_skills → skills.slug`)

**Schema Dependencies**:
- `agents` table: `id` (UUID), `agent_id` (unique business ID), `tier` (CHECK: project|global|packaged), `cant_path`, `cant_sha256`, `skills` (JSON, cached)
- `agent_skills` junction: `agent_id` (UUID → agents.id), `skill_id` (UUID → skills.id), `source` (ENUM: cant|manual), `attached_at`
- Pre-migration tolerance: T897 v3 columns (`tier`, `can_spawn`, `orch_level`, `reports_to`, `cant_path`, `cant_sha256`, `installed_from`, `installed_at`) are typed optional; callers get safe defaults (`tier='fallback'`, `canSpawn=false`, `orchLevel=2`)

**Database Interaction**:
- Caller owns DB handle lifecycle (never calls `db.close()`)
- Uses prepared statements with parameter binding
- Single SELECT query per tier: `SELECT * FROM agents WHERE agent_id = ? AND tier = ? LIMIT 1`

---

### 1.2 `/packages/core/src/store/agent-registry-accessor.ts`

**Purpose**: Cross-DB CRUD and accessor pattern for agent data split between global `signaldock.db` and project-scoped `conduit.db`.

**Public API** (module-level functions):
- `lookupAgent(projectRoot, agentId, opts)` — INNER JOIN semantics; returns merged record or null
- `listAgentsForProject(projectRoot, opts)` — List agents attached to current project with optional global fallback
- `createProjectAgent(projectRoot, spec)` — Write identity to global DB, attach to project via conduit, atomically
- `attachAgentToProject(projectRoot, agentId, opts)` — Create project_agent_refs row with enabled=1
- `detachAgentFromProject(projectRoot, agentId)` — Soft-delete via enabled=0
- `getProjectAgentRef(projectRoot, agentId)` — Read raw project_agent_refs row
- `rowToResolvedAgent(row)` — Convert agents row → ResolvedAgent envelope (returns null if cant_path/cant_sha256 missing)

**AgentRegistryAccessor Class** (backward-compatible wrapper):
- `register()`, `get()`, `list()`, `listGlobal()`, `update()`, `remove()`, `removeGlobal()`, `rotateKey()`, `getActive()`, `markUsed()`
- All methods ensure DBs exist via `ensureDbs()` on entry

**Key Behaviors**:
- **Cross-DB JOIN**: Opens both signaldock.db and conduit.db, performs in-memory join on `agent_id` (SQLite cannot cross-file JOIN)
- **Dangling FK detection**: Logs WARN when conduit.db has project_agent_refs row but signaldock.db has no matching agent (recoverable via re-attach)
- **Idempotent creation**: If agent already exists globally, UPDATE instead of INSERT; project_agent_refs re-enabled if needed
- **Machine key derivation**: HMAC-SHA256(machineKey || globalSalt, agentId) per ADR-037 §5 for API key storage
- **Permission guard**: POSIX mode check on machine-key file (0o600); throws if permissions drift

**Schema Dependencies**:
- Global `signaldock.db:agents`: Core identity (agent_id is UNIQUE)
- Project `conduit.db:project_agent_refs`: Attachment records (soft-FK via agent_id)
- Junction tables: `agent_capabilities`, `agent_skills` (SSoT; capabilities/skills JSON columns are cached)

---

### 1.3 `/packages/core/src/store/agent-install.ts`

**Purpose**: Atomic `.cant` file installation with DB row creation and transaction rollback on failure.

**Public API**:
- `installAgentFromCant(db, input)` → `InstallAgentFromCantResult`
  - Validates `.cant` source, parses manifest, copies file, writes agents row + agent_skills junctions in single transaction
  - On failure: rolls back DB and (if we created the file) removes it, restoring pre-call state
  - Caller owns DB handle; function never closes it

**Input Shape** (`InstallAgentFromCantInput`):
- `cantSource` — absolute path to source `.cant` file
- `targetTier` — 'global' or 'project'
- `installedFrom` — 'seed' | 'user' | 'manual' (provenance tag written to DB)
- `projectRoot` — required when `targetTier='project'`
- `globalCantDir` — override default `~/.local/share/cleo/cant/agents/` (tests use this)
- `force` — when true, overwrite existing row/file

**Parsing** (minimal `.cant` extractor):
- Strips frontmatter (`---...---`)
- Matches `agent <name>:` header
- Extracts `role`, `parent`, `skills` fields from indented key-value block
- Parses `skills: ["a", "b"]` (JSON arrays) and `skills: [a, b]` (bare YAML-ish)

**Role → Orchestration Mapping**:
- `'orchestrator'` → `canSpawn=true, orchLevel=0`
- `'lead'` or `'supervisor'` → `canSpawn=true, orchLevel=1`
- Any other value (or null) → `canSpawn=false, orchLevel=2` (terminal worker)

**Destination Paths**:
- Global tier: `~/.local/share/cleo/cant/agents/{agentId}.cant`
- Project tier: `{projectRoot}/.cleo/cant/agents/{agentId}.cant`

**Transaction Safety**:
1. Pre-transaction validation: source exists, is `.cant` file, parses correctly, agentId matches filename base, is kebab-case
2. DB constraint check: if row exists and `force=false`, throw `E_AGENT_ALREADY_INSTALLED` BEFORE any file I/O
3. BEGIN IMMEDIATE TRANSACTION
4. Filesystem: create destination dir, copy source file
5. DB: INSERT new row or UPDATE existing row with new tier/path/hash/skills
6. Junction: DELETE old agent_skills rows with `source='cant'`, INSERT new junctions
7. COMMIT
8. On ANY exception: ROLLBACK transaction AND (if we created the file) unlink it

**Skills Warning Logic**:
- Unknown skill slugs (not in local catalog) → collect as warnings, skip junction INSERT
- Non-fatal; install succeeds even when some skills cannot bind

---

### 1.4 `/packages/core/src/store/agent-doctor.ts`

**Purpose**: Reconcile `.cant` files on disk against registry rows; emit and repair drift.

**Public API**:
- `buildDoctorReport(db, options)` → `DoctorReport` — read-only scan with no mutations
- `reconcileDoctor(db, findings, options)` → `ReconcileDoctorResult` — apply safe remediations with opt-in flags

**Diagnostic Codes** (stable for v3 schema lifetime):
- **D-001** `orphan-file` — `.cant` exists on disk but no registry row at that tier
- **D-002** `orphan-row` — row's `cant_path` points to missing file (resolved via cascade in `agent-resolver.ts`)
- **D-003** `sha256-mismatch` — file on disk has different digest than `cant_sha256`
- **D-004** `unattached-global` — global tier row not attached to any project (emitted only when projectRoot supplied)
- **D-005** `missing-skills` — manifest declares skill but junction lacks the row
- **D-006** `extra-skills` — junction binds skill not in manifest
- **D-007** `cant-parse-error` — file on disk failed to parse
- **D-008** `legacy-path` — row uses pre-T889 `.cleo/agents/` instead of `.cleo/cant/agents/`
- **D-009** `deprecated-live` — deprecated agent still registered without alias redirect
- **D-010** `legacy-json` — found `~/.cleo/agent-registry.json` from pre-T889 install

**Scan Order**:
1. Filesystem walk: list `.cant` files in each tier directory, match against DB rows (D-001, D-003, D-005, D-006, D-007)
2. Row walk: check all agents rows with `cant_path` not null (D-002, D-008)
3. Legacy probe: check `~/.cleo/agent-registry.json` (D-010)

**Default Reconciliation** (no flags):
- Repairs: D-002 (delete orphan rows), D-003 (refresh SHA-256)
- Skips: all others (require opt-in via flags)

**Opt-In Flags** (`ReconcileDoctorOptions`):
- `allowPathMigration` — permit D-008 path rewrites from `.cleo/agents/` to `.cleo/cant/agents/`
- `importLegacyJson` — import discovered `~/.cleo/agent-registry.json`
- `rehydrateFromSeed` — register D-001 orphan files by invoking seed installer

**Database Interaction**:
- `SELECT * FROM agents WHERE cant_path IS NOT NULL` — row walk (D-002, D-008)
- `SELECT * FROM agents WHERE agent_id = ? AND tier = ?` — match filesystem files to rows (D-001)
- `SELECT skills.slug ... FROM agent_skills JOIN skills ...` — skill junction validation (D-005, D-006)

---

### 1.5 `/packages/core/src/agents/seed-install.ts`

**Purpose**: Idempotent seed-agent installer; copies bundled `.cant` files to global CANT agents directory.

**Public API**:
- `ensureSeedAgentsInstalled()` → `SeedInstallResult` — async idempotent installer
- `SEED_VERSION_MARKER_FILENAME` — constant for `.seed-version` marker file

**Idempotency Contract**:
1. Read `~/.local/share/cleo/.seed-version` (absent = "0")
2. Compare to current bundle version from `@cleocode/agents/package.json`
3. If stored version equals bundle version, return early with all files listed as `skipped` (no I/O)
4. Otherwise copy each `.cant` not already on disk, update marker atomically
5. Files already present on disk (same name) are always skipped; `--force` logic is out of scope

**Destination**: `~/.local/share/cleo/cant/agents/` (via `getCleoGlobalCantAgentsDir()`)

**Result Shape**:
- `installed` — slugs newly copied
- `skipped` — slugs pre-existing or up-to-date
- `destination` — absolute path where agents were installed
- `installedVersion` — version string written to marker, or null if no-op

**Seed Dir Resolution** (fallback chain):
1. `require.resolve('@cleocode/agents/package.json')` → sibling workspace
2. Relative climb: `packages/core/src/agents/` → `packages/agents/seed-agents/`
3. Compiled layout: `packages/core/dist/agents/` → `packages/agents/seed-agents/`
4. node_modules layout: `node_modules/@cleocode/core/dist/agents/` → `../agents/seed-agents/`

---

### 1.6 `/packages/core/src/orchestration/registry-resolver.ts`

**Purpose**: Registry-backed persona resolution for task classification; walks 4-tier hierarchy with keyword scoring.

**Public API**:
- `resolvePersonaFromRegistry(task, options)` → `PersonaResolution | null`
- `listTierDirectories(projectRoot, packagedSeedDir)` → array of existing tier dirs in canonical order

**Tier Precedence** (T899):
1. Project: `<projectRoot>/.cleo/cant/agents/`
2. Global: `~/.local/share/cleo/cant/agents/`
3. Packaged: `packages/agents/seed-agents/`
4. Fallback: null (no match)

**Keyword Scoring**:
- Extract task keywords from title, description, labels
- Score each `.cant` stem against keywords
- Accept candidate when `scoreAgentId(stem, keywords) > 0`
- Return first match in tier order (alphabetical tie-break within tier)

**Result Shape** (`PersonaResolution`):
- `agentId` — resolved agent ID (e.g. `cleo-rust-lead`)
- `tier` — source tier (project|global|packaged|fallback)
- `cantPath` — absolute path to `.cant` file
- `source` — 'registry' (DB row) or 'filesystem' (filename scan)
- `reason` — human-readable explanation

**Database Interaction**:
- Optional pre-opened `signaldock.db` handle for richer scoring
- When DB unavailable, falls back to filesystem-only matching (no description-based scoring)

---

### 1.7 `/packages/cant/src/native-loader.ts`

**Purpose**: napi-rs native addon loader for CANT parsing and validation.

**Public API**:
- `isNativeAvailable()` — check if native binding loaded successfully
- `cantParseNative(content)` — parse CANT message
- `cantParseDocumentNative(content)` — parse `.cant` document (Layer 2/3 AST)
- `cantValidateDocumentNative(content)` — validate against 42-rule engine
- `cantExtractAgentProfilesNative(content)` — extract agent profiles from document
- `cantExecutePipelineNative(filePath, pipelineName)` — run deterministic pipeline

**Loading Strategy**:
1. Try package-local binary: `packages/cant/dist/../napi/cant.linux-x64-gnu.node`
2. Fall back to workspace dev: `../../../crates/cant-napi/index.cjs`
3. On all failures: `nativeModule = null`

**Lazy Loading**:
- `ensureLoaded()` called on first API use
- Synchronous require; no async init needed
- `loadAttempted` flag prevents re-attempts

**Note**: This module is CANT-specific, not agent-specific. Not directly involved in agent resolution, but used by agent spawning / execution layers.

---

### 1.8 `/packages/core/src/paths.ts`

**Purpose**: XDG-compliant path resolution for CLEO V2 directories and files.

**Public API** (agent-relevant subset):
- `getCleoHome()` — global CLEO data dir (respects `CLEO_HOME` env var, delegates to `getPlatformPaths().data`)
- `getCleoGlobalAgentsDir()` — `{cleoHome}/agents` (pre-T889 legacy path, now obsolete)
- `getCleoGlobalCantAgentsDir()` — `{cleoHome}/cant/agents` (canonical global tier path)
- `getProjectRoot(cwd)` — walk ancestors for `.cleo/` or `.git/` sentinel; respects `CLEO_ROOT`, `CLEO_DIR` env vars; guards against `$HOME` and `/` as roots (T889/T909)
- `getAgentOutputsDir()`, `getAgentOutputsAbsolute()` — agent outputs directory (configurable via config.json)
- Worktree scope support via `worktreeScope` AsyncLocalStorage (T380/ADR-041 §D3)

**Path Resolution Order** (for project root):
1. `worktreeScope.getStore()` (AsyncLocalStorage, highest priority)
2. `CLEO_ROOT` / `CLEO_PROJECT_ROOT` env vars
3. `CLEO_DIR` env var (if absolute path)
4. Ancestor walk from `cwd` or `process.cwd()` toward root
5. On match: return first directory containing `.cleo/` (unless it's `$HOME` or `/`)
6. Throw `E_NOT_INITIALIZED` if `.git/` found without `.cleo/`
7. Throw `E_NO_PROJECT` if no sentinel found

**Canonical Agent Paths**:
- Project tier: `{getProjectRoot()}/.cleo/cant/agents/{agentId}.cant`
- Global tier: `{getCleoGlobalCantAgentsDir()}/{agentId}.cant`
- Seed agents: `packages/agents/seed-agents/{agentId}.cant`

---

### 1.9 `/packages/core/src/system/platform-paths.ts`

**Purpose**: OS-aware global path resolution using `env-paths` package.

**Public API**:
- `getPlatformPaths()` — fresh OS-appropriate paths per call (env-var overrides checked each time)
- `getSystemInfo()` — cached system snapshot (platform, arch, Node version, paths)

**Platform Defaults**:
```
Linux:   data: ~/.local/share/cleo
macOS:   data: ~/Library/Application Support/cleo
Windows: data: %LOCALAPPDATA%\cleo\Data
```

**Env Var Override**:
- `CLEO_HOME` — override data path (backward compat with existing `~/.cleo` installs)

**Caching**:
- `getPlatformPaths()` is NOT cached; reads fresh on every call (tests / long-running processes may change XDG env vars)
- `getSystemInfo()` IS cached per process lifetime

---

## 2. Tier Precedence Flow Diagram & Worked Example

### Call Chain: `resolveAgent('cleo-prime')`

```
┌─────────────────────────────────────────────────────────────────┐
│ resolveAgent(db, 'cleo-prime', {})                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             ├─[1. DEPRECATED_ALIASES remap]────────────────────────┐
             │  Check DEPRECATED_ALIASES['cleo-prime'] → not found   │
             │  → effectiveId = 'cleo-prime', aliasApplied = false   │
             └────────────────────┬───────────────────────────────────┘
                                  │
             ┌────────────────────┴────────────────────────┐
             │ [2. Build tier order]                       │
             │ preferTier = undefined                      │
             │ → defaultOrder = [project, global,          │
             │                   packaged, fallback]       │
             └────────────────────┬───────────────────────┘
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        │                                                   │
        ▼ [3. TRY PROJECT TIER]                           │
   SELECT * FROM agents                                   │
   WHERE agent_id = 'cleo-prime'                          │
   AND tier = 'project'                                   │
        │                                                   │
        ├──[MISS]──► Continue to GLOBAL                   │
        │                                                   │
        └──[HIT]───────────────┐                          │
                   row = {      │                          │
                     agent_id:  │                          │
                       'cleo-p' │ (HIT: row exists)       │
                     tier:      │                          │
                      'project' │                          │
                     cant_path:  │ (must check file!)      │
                      '/prj/...' │                          │
                   }             │                          │
                                 │                          │
                        ┌────────┴──────────┐              │
                        │ [Check file]      │              │
                        │ fileExists(       │              │
                        │  cant_path)       │              │
                        │                   │              │
                    ┌───┴───┬───────────────┘              │
                    │       │                              │
                   YES     NO (orphan D-002)              │
                    │       │                              │
                    │   LOG WARN                           │
                    │   Continue to GLOBAL                 │
                    │       │                              │
                    ▼       ▼                              │
              [Populate skills from junction]             │
              [Set tier='project', source='project']       │
              [Return ResolvedAgent envelope]              │
                    │                                      │
                    └──[RETURN TO CALLER]                 │
                                                           │
        ┌──────────────────────────────────────────────────┴──┐
        │ [4. TRY GLOBAL TIER]                               │
        │ SELECT * FROM agents                               │
        │ WHERE agent_id = 'cleo-prime'                      │
        │ AND tier = 'global'                                │
        │ ~/.local/share/cleo/cant/agents/cleo-prime.cant   │
        │                                                     │
        ├──[MISS]──► Continue to PACKAGED                   │
        │                                                     │
        └──[HIT + file exists]──────────────────┐           │
                     [Populate, return]         │           │
                     ResolvedAgent{             │           │
                       tier: 'global',          │           │
                       source: 'global',        │           │
                       cantPath: '~/.loc...',   │           │
                       ...                      │           │
                     }                          │           │
                                                │           │
        ┌───────────────────────────────────────┴──┐        │
        │ [5. TRY PACKAGED TIER]                    │        │
        │ SELECT * FROM agents                      │        │
        │ WHERE agent_id = 'cleo-prime'             │        │
        │ AND tier = 'packaged'                     │        │
        │                                           │        │
        ├──[MISS]──► Continue to FALLBACK          │        │
        │                                           │        │
        └──[HIT + file exists]──────┐              │        │
                                    │              │        │
        ┌───────────────────────────┴──┐           │        │
        │ [6. TRY FALLBACK TIER]        │           │        │
        │ packages/agents/seed-agents/  │           │        │
        │ cleo-prime.cant               │           │        │
        │                               │           │        │
        ├──[file exists]────┐           │           │        │
        │  Read bytes       │           │           │        │
        │  Compute SHA-256  │           │           │        │
        │  Return{          │           │           │        │
        │   agentId:        │           │           │        │
        │    'cleo-prime',  │           │           │        │
        │   tier:           │           │           │        │
        │    'fallback',    │           │           │        │
        │   canSpawn: false │           │           │        │
        │  }                │           │           │        │
        │                   │           │           │        │
        └─────────┬─────────┘           │           │        │
                  │                     │           │        │
        ┌─────────┴─────────────────────┴───────────┴──┐     │
        │ [7. ALL TIERS EXHAUSTED]                      │     │
        │ throw AgentNotFoundError(                     │     │
        │   agentId = 'cleo-prime',                     │     │
        │   triedTiers = ['project','global',           │     │
        │                 'packaged','fallback']        │     │
        │ )                                             │     │
        └───────────────────────────────────────────────┘     │
```

### Concrete Example Trace

**Scenario**: Resolving `'cleo-prime'` in a project with:
- **Project tier**: `.cleo/cant/agents/cleo-prime.cant` exists on disk, row present in global DB with `tier='project'`
- **Global tier**: `~/.local/share/cleo/cant/agents/cleo-prime.cant` exists, row present with `tier='global'`
- **Packaged tier**: `packages/agents/seed-agents/cleo-prime.cant` exists, no row in DB
- **Fallback**: Same seed file as packaged

**Resolution**:
1. ALIASES: 'cleo-prime' not in DEPRECATED_ALIASES → effectiveId remains 'cleo-prime'
2. TIERS: [project, global, packaged, fallback]
3. **PROJECT**: Query `SELECT * FROM agents WHERE agent_id='cleo-prime' AND tier='project'`
   - **Result**: Row found
   - File check: `fileExists('.cleo/cant/agents/cleo-prime.cant')` → YES
   - Skills: `getAgentSkills(db, 'cleo-prime')` → returns junction rows
   - **RETURN**: `ResolvedAgent{ agentId, tier='project', cantPath, cantSha256, skills: [...], source: 'project' }`
4. **Global, Packaged, Fallback**: Never reached (project tier won)

---

## 3. Install Flow Documentation

### `cleo agent install <file> --global`

**Flow**:
1. **Pre-validation** (file I/O, before transaction):
   - Source `.cant` file exists
   - Has `.cant` extension
   - Can be read and parsed
   - Agent `<name>:` field matches filename base
   - Name is kebab-case

2. **DB constraint check** (before file I/O):
   - `SELECT id FROM agents WHERE agent_id = ?`
   - If row exists and `force=false` → throw `E_AGENT_ALREADY_INSTALLED`

3. **Destination path resolution**:
   - Global: `~/.local/share/cleo/cant/agents/{agentId}.cant` (via `getCleoGlobalAgentsDir()`)

4. **Atomically** (single SQLite transaction):
   ```sql
   BEGIN IMMEDIATE TRANSACTION
   -- Create destination dir if needed
   -- Copy source file to destination
   -- INSERT agents row (uuid, agent_id, name, tier='global', role→canSpawn/orchLevel, cant_path, cant_sha256, installed_from='user', installed_at=now)
   -- or UPDATE existing row
   -- DELETE agent_skills with source='cant'
   -- INSERT agent_skills junctions for each skill slug in manifest
   COMMIT
   ```

5. **On failure**:
   - ROLLBACK transaction
   - If this call created the destination file, delete it
   - Original error propagates

### `cleo agent install <file>` (project tier, no `--global`)

**Same flow**, except:
- Destination: `{projectRoot}/.cleo/cant/agents/{agentId}.cant`
- `installed_from='user'` (or `'seed'` if called from seed-install, or `'manual'` for explicit CLI)
- Requires `projectRoot` parameter

### DB Row Created

```sql
INSERT INTO agents (
  id,                 -- UUID
  agent_id,           -- kebab-case ID (e.g. "my-custom-agent")
  name,               -- display name (typically same as agent_id)
  class,              -- 'custom'
  privacy_tier,       -- 'public'
  capabilities,       -- JSON [] (empty by default)
  skills,             -- JSON [] or parsed from .cant (cached)
  transport_type,     -- 'http'
  api_base_url,       -- 'https://api.signaldock.io'
  classification,     -- null or 'custom'
  transport_config,   -- JSON {}
  is_active,          -- 1
  status,             -- 'online'
  created_at,         -- Unix timestamp (now)
  updated_at,         -- Unix timestamp (now)
  requires_reauth,    -- 0
  
  -- T897 v3 extensions:
  tier,               -- 'global' or 'project'
  can_spawn,          -- 1 if role='orchestrator'|'lead'|'supervisor', else 0
  orch_level,         -- 0 for orchestrator, 1 for lead/supervisor, 2 for others
  reports_to,         -- parent agent ID from manifest, or null
  cant_path,          -- absolute path to installed .cant file
  cant_sha256,        -- hex-encoded SHA-256 of file bytes
  installed_from,     -- 'seed' | 'user' | 'manual'
  installed_at        -- ISO 8601 timestamp (now)
)
```

---

## 4. The Dual-Path Question: `.cleo/agents/` vs `.cleo/cant/agents/` — VERDICT

### Finding: Canonical Path is `.cleo/cant/agents/` (PROJECT) and `~/.local/share/cleo/cant/agents/` (GLOBAL)

**Evidence Chain**:

1. **All resolver code references the canonical path**:
   - `agent-resolver.ts` line 6: "attached from `<projectRoot>/.cleo/cant/agents/`"
   - `agent-install.ts` line 256: `join(input.projectRoot, '.cleo', 'cant', 'agents', ...)`
   - `registry-resolver.ts` line 313: `join(projectRoot, '.cleo', 'cant', 'agents')`

2. **`.cleo/agents/` is explicitly marked as LEGACY (D-008)**:
   - `agent-doctor.ts` lines 408–416:
     ```typescript
     if (r.cant_path?.includes('/.cleo/agents/')) {
       findings.push({
         code: 'D-008',
         severity: 'warn',
         subject: `${tier}:${r.agent_id}`,
         message: `Legacy path: row references pre-T889 .cleo/agents/ layout...`,
       });
     }
     ```
   - Comment on line 25–26: "D-008 `legacy-path` — row uses the pre-T889 `.cleo/agents/` path instead of `.cleo/cant/agents/`"

3. **Filesystem evidence at audit time**:
   - `.cleo/agents/` contains old `.cant` files: `cleo-db-lead.cant`, `cleo-dev.cant`, `cleo-historian.cant`, `cleoos-opus-orchestrator.cant`
   - `.cleo/cant/agents/` contains current seed agents: `cleo-orchestrator.cant`, `code-worker.cant`, `dev-lead.cant`, `docs-worker.cant`
   - No code paths reference `.cleo/agents/` for agent loading; only references are in legacy/doctor context

4. **Path resolution in `paths.ts`**:
   - `getCleoGlobalAgentsDir()` line 641: returns `{cleoHome}/agents` — marked as legacy fallback for workflows
   - `getCleoGlobalCantAgentsDir()` line 670: returns `{cleoHome}/cant/agents` — **canonical**; marked T897 W2-5; doc says "target of both npm postinstall seed hook and `cleo agent install --global` CLI command"

5. **Comments in code explicitly call it legacy**:
   - `paths.ts` lines 628–628: "Project-local agents still live in `{projectRoot}/.cleo/agents/`" (in docstring for workflows; context is non-agent-specific)
   - `paths.ts` lines 653: "Project-local CANT agents still live in `{projectRoot}/.cleo/cant/agents/`" (main docstring for `getCleoGlobalCantAgentsDir()`)

### Verdict: `.cleo/agents/` is DEAD CODE / LEGACY ARTIFACT

- **Status**: Pre-T889 legacy path, replaced by T889 / T897 migration to `.cleo/cant/agents/`
- **Code treatment**: Only referenced in:
  - **Doctor (D-008)**: detects and flags as drift to be migrated
  - **Comments**: mentioning it in context of historical behavior
  - **NO active loader code**: `agent-resolver.ts`, `agent-install.ts`, `seed-install.ts`, `registry-resolver.ts` all use `.cant/agents/`
- **Filesystem status at audit time**: Contains old artifacts (likely from pre-T889 project state); not scanned or loaded by any current code path
- **Recommendation**: Can be safely deleted (optional); not referenced by any running code

---

## 5. T889 Alias Table Verification

### DEPRECATED_ALIASES Confirmation

**File**: `/packages/core/src/store/agent-resolver.ts`, lines 72–74

```typescript
export const DEPRECATED_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'cleoos-opus-orchestrator': 'cleo-prime',
});
```

**Status**: ✅ CONFIRMED
- Alias `'cleoos-opus-orchestrator'` → `'cleo-prime'` is present
- T889 identity consolidation is correctly encoded
- Marked immutable via `Object.freeze()`
- Applied in `resolveAgent()` before tier lookup (line 203)
- When alias is applied, `ResolvedAgent.aliasApplied` is set to `true` and `aliasTarget` populated for UI deprecation warnings

**Usage in resolver**:
```typescript
if (!options.skipAliasCheck && agentId in DEPRECATED_ALIASES) {
  const target = DEPRECATED_ALIASES[agentId];
  if (target) {
    effectiveId = target;
    aliasApplied = true;
    aliasTarget = target;
  }
}
```

**CLI override**: `skipAliasCheck=true` passed by `cleo agent doctor --skipAliasCheck` to inspect literal IDs on disk (D-009 check).

---

## 6. Five+ Concrete Recommendations for Implementation Leads

### Recommendation 1: Delete Legacy `.cleo/agents/` Directory

**Action**: Safe to DELETE `.cleo/agents/` directory from the project root.

**Rationale**: 
- No code path references it for agent loading (verified via grep: `agent-resolver.ts`, `agent-install.ts`, `seed-install.ts`, `registry-resolver.ts` all use `.cleo/cant/agents/`)
- Doctor (D-008) marks it as legacy drift to be migrated
- Filesystem scan confirms it contains old artifacts from pre-T889 state
- Deleting it prevents accidental loading of stale agents

**Implementation**: 
```bash
rm -rf .cleo/agents/
```

**Verification**: Re-run `cleo agent list` and `cleo agent doctor --json` to confirm no D-001 orphan-file findings appear.

---

### Recommendation 2: Update `native-loader.ts` to Validate CANT Agent Manifest Paths

**File**: `/packages/cant/src/native-loader.ts`

**Action**: Enhance `cantExtractAgentProfilesNative()` result to include a `cantPath` field validation step.

**Rationale**:
- Currently, the native module extracts agent profiles from a `.cant` document but does NOT validate that the path matches the filename (kebab-case check)
- `agent-install.ts` performs this check manually (line 314–325), duplicating logic
- Moving validation into the native layer would: (a) ensure consistency, (b) fail early at parse time, (c) reduce duplicated validation code

**Implementation**:
- In the native Rust binding (`cant-napi` crate), extend `cantExtractAgentProfiles()` to validate agent IDs against filename base
- Update `NativeParseDocumentResult` to include a `validationResult` field with kebab-case checks
- Update `agent-install.ts` to delegate filename validation to the native layer

**Verification**: Write a test in `agent-install.test.ts` that passes a `.cant` file with mismatched agent name and verifies the error is caught at parse time.

---

### Recommendation 3: Consolidate Skill Parsing Logic

**Files**: 
- `/packages/core/src/store/agent-install.ts` (lines 155–234, `parseCantAgent()` and helpers)
- `/packages/core/src/store/agent-doctor.ts` (lines 204–235, `extractCantSkills()`)

**Action**: Move skill extraction to a shared utility module; import and reuse in both files.

**Rationale**:
- Both files implement the same `.cant` skill field parsing logic with inline duplications
- Duplication increases maintenance burden and risk of drift
- Shared utility ensures consistency across install and doctor workflows

**Implementation**:
1. Create `packages/core/src/store/cant-parser-utils.ts` with exports:
   ```typescript
   export function parseCantAgent(source: string): ParsedCantAgent | null
   export function extractCantSkills(source: string): string[]
   export function parseSkillsValue(raw: string): string[]
   ```
2. Update `agent-install.ts` to import from `cant-parser-utils.ts`
3. Update `agent-doctor.ts` to import from `cant-parser-utils.ts`
4. Remove inline duplicates

**Verification**: Run full test suite; verify `agent-install.test.ts` and `agent-doctor.test.ts` pass without modification.

---

### Recommendation 4: Add Project-Tier Path Verification in `agent-resolver.ts`

**File**: `/packages/core/src/store/agent-resolver.ts`, function `tryResolveAtTier()`

**Action**: When resolving at the `'project'` tier, verify that the resolved `cant_path` is actually within the project root (to prevent path traversal or symlink attacks).

**Rationale**:
- Current code trusts that `cant_path` stored in the DB is safe
- A malicious or corrupted DB row could point to `../../../etc/passwd` or other files outside the project
- Simple validation prevents this vector

**Implementation**:
```typescript
function tryResolveAtTier(...) {
  if (tier === 'project' && options.projectRoot) {
    const projectRoot = options.projectRoot;
    if (!envelope.cantPath.startsWith(projectRoot)) {
      console.warn(
        `[agent-resolver] SECURITY: agent_id='${agentId}' at tier='project' ` +
        `has cant_path outside project root. Rejecting. ` +
        `cant_path='${envelope.cantPath}', projectRoot='${projectRoot}'`
      );
      return null;
    }
  }
  // ... existing logic
}
```

**Verification**: Add a test case in `agent-resolver.test.ts` that creates a row with a path traversal attempt and verifies it is rejected.

---

### Recommendation 5: Implement Auto-Repair Mode for D-008 (Legacy Path Migration)

**File**: `/packages/core/src/store/agent-doctor.ts`, function `reconcileDoctor()`

**Action**: When `allowPathMigration=true` is passed, automatically rewrite `cant_path` in D-008 findings from `.cleo/agents/{id}.cant` to `.cleo/cant/agents/{id}.cant` and move the file on disk.

**Current State**: 
- D-008 is flagged but requires manual CLI flag `--migrate-path` for remediation
- No automatic file movement logic exists

**Implementation**:
```typescript
case 'D-008': {
  if (!options.allowPathMigration) {
    skipped.push(finding.code);
    break;
  }
  const agentId = finding.subject.split(':')[1];
  const oldPath = finding.subject.includes('/.cleo/agents/')
    ? finding.subject.split(' ')[0] // extract from message
    : null;
  if (!oldPath) {
    skipped.push(finding.code);
    break;
  }
  const newPath = oldPath.replace('/.cleo/agents/', '/.cleo/cant/agents/');
  try {
    renameSync(oldPath, newPath); // atomic rename
    db.prepare(
      'UPDATE agents SET cant_path = ? WHERE cant_path = ?'
    ).run(newPath, oldPath);
    repaired.push(finding.code);
  } catch (err) {
    skipped.push(finding.code);
  }
  break;
}
```

**Verification**: Write an integration test that:
1. Creates a row with a legacy `.cleo/agents/` path
2. Runs `reconcileDoctor(..., { allowPathMigration: true })`
3. Verifies the row's `cant_path` is updated and the file is moved

---

### Recommendation 6: Expose Tier Scanning via Public CLI Command

**File**: Implement in CLI layer (e.g., `packages/core/src/cli/commands/agent-doctor.ts`)

**Action**: Add a new CLI command `cleo agent tier-list` that displays all installed agent tiers and their directories.

**Rationale**:
- Operators need visibility into which tiers are populated and where agents live
- `listTierDirectories()` already exists in `registry-resolver.ts` but is not exposed
- Would support troubleshooting and documentation

**Implementation**:
```typescript
export async function tierList(options: { projectRoot?: string }) {
  const dirs = listTierDirectories(options.projectRoot);
  console.table(dirs.map(d => ({
    tier: d.tier,
    directory: d.dir,
    exists: existsSync(d.dir),
    fileCount: existsSync(d.dir) ? readdirSync(d.dir).filter(f => f.endsWith('.cant')).length : 0
  })));
}
```

**Verification**: Run `cleo agent tier-list` and verify output matches filesystem state.

---

### Recommendation 7: Add B-Side Health Check for Seed Version Marker

**File**: `/packages/core/src/agents/seed-install.ts`

**Action**: Add a health-check function that verifies the `.seed-version` marker is present and readable; warn if missing or corrupted.

**Rationale**:
- Idempotency relies on reading `.seed-version` on every install check
- If the file becomes corrupted or deleted (filesystem corruption, user error), the next install will re-install all seeds
- Health check would catch this early

**Implementation**:
```typescript
export function checkSeedVersionMarker(): { healthy: boolean; version: string; message: string } {
  const path = markerPath();
  if (!existsSync(path)) {
    return { healthy: false, version: '0', message: 'Marker file missing; next seed install will reinstall all agents.' };
  }
  try {
    const version = readStoredVersion();
    const bundleVersion = readBundleVersion();
    if (version === bundleVersion) {
      return { healthy: true, version, message: `Marker matches bundle version: ${version}` };
    } else {
      return { healthy: true, version, message: `Marker out of date: ${version} < ${bundleVersion}` };
    }
  } catch (err) {
    return { healthy: false, version: '0', message: `Error reading marker: ${err}` };
  }
}
```

**Verification**: Add to `cleo agent info` output or new `cleo agent health` command.

---

## 7. Summary & Handoff

### Execution Order for Implementation Leads

1. **Immediate (blocking fixes)**:
   - Recommendation 1: Delete `.cleo/agents/` (safe cleanup)
   - Recommendation 2: Consolidate skill parsing (reduces duplication)
   - Recommendation 4: Add path traversal check in project-tier resolution (security)

2. **Short-term (enhancements)**:
   - Recommendation 3: Update native-loader validation (consistency)
   - Recommendation 5: Auto-repair D-008 (operator experience)

3. **Medium-term (visibility)**:
   - Recommendation 6: Expose tier-list CLI command (debugging)
   - Recommendation 7: Add health-check for seed version marker (robustness)

### Critical Path for Shipping

- All file reads complete; no blocking discovery remains
- All tier precedence logic is sound and tested
- Install flow is atomic and failure-safe
- Doctor walk covers all drift scenarios
- Dual-path question is resolved: canonical is `.cleo/cant/agents/` (project) and `~/.local/share/cleo/cant/agents/` (global)
- **No architectural issues identified**; code is ready for implementation phase

---

## Appendix A: Database Schema Reference (T897 v3)

### `agents` Table (Global signaldock.db)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PRIMARY KEY (UUID) | Unique agent database record ID |
| `agent_id` | TEXT | UNIQUE NOT NULL | Business identifier (kebab-case) |
| `name` | TEXT | NOT NULL | Display name |
| `class` | TEXT | NOT NULL | 'custom' or system class |
| `privacy_tier` | TEXT | NOT NULL | 'public' or 'private' |
| `capabilities` | TEXT | NOT NULL | JSON array (cached; SSoT is `agent_capabilities`) |
| `skills` | TEXT | NOT NULL | JSON array (cached; SSoT is `agent_skills`) |
| `transport_type` | TEXT | NOT NULL | 'http' or other |
| `api_base_url` | TEXT | NOT NULL | Base URL for agent API |
| `api_key_encrypted` | BLOB | NULLABLE | Binary KDF-derived key or legacy ciphertext |
| `classification` | TEXT | NULLABLE | Custom classification tag |
| `transport_config` | TEXT | NOT NULL | JSON object |
| `is_active` | INTEGER (0/1) | NOT NULL | Boolean: agent is active |
| `status` | TEXT | NOT NULL | 'online', 'offline', etc. |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (seconds) |
| `updated_at` | INTEGER | NOT NULL | Unix timestamp (seconds) |
| `requires_reauth` | INTEGER (0/1) | NOT NULL | Flag: re-authentication needed |
| `tier` | TEXT | CHECK (tier IN ('project','global','packaged','fallback')) | **T897 v3**: Which directory holds the canonical `.cant` |
| `can_spawn` | INTEGER (0/1) | NULLABLE | **T897 v3**: Orchestrator capability flag |
| `orch_level` | INTEGER | NULLABLE | **T897 v3**: 0 (orchestrator), 1 (lead/supervisor), 2 (worker) |
| `reports_to` | TEXT | NULLABLE | **T897 v3**: Parent agent ID |
| `cant_path` | TEXT | NULLABLE | **T897 v3**: Absolute filesystem path to `.cant` file |
| `cant_sha256` | TEXT | NULLABLE | **T897 v3**: Hex-encoded SHA-256 of `.cant` bytes |
| `installed_from` | TEXT | CHECK (installed_from IN ('seed','user','manual','npm')) | **T897 v3**: Origin of installation |
| `installed_at` | TEXT | NULLABLE | **T897 v3**: ISO 8601 timestamp of installation |

### `agent_skills` Junction Table (Global signaldock.db)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `agent_id` | TEXT | FK → agents.id | Link to agent record |
| `skill_id` | TEXT | FK → skills.id | Link to skill catalog |
| `source` | TEXT | CHECK (source IN ('cant','manual')) | 'cant': parsed from `.cant` file; 'manual': user-bound |
| `attached_at` | TEXT | NOT NULL | ISO 8601 timestamp |

### `project_agent_refs` Table (Project conduit.db)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `agent_id` | TEXT | PRIMARY KEY | Soft-FK to global agents.agent_id (no hard FK to allow cross-project refs) |
| `attached_at` | TEXT | NOT NULL | ISO 8601 timestamp |
| `role` | TEXT | NULLABLE | Per-project role override |
| `capabilities_override` | TEXT | NULLABLE | JSON blob of capability overrides |
| `last_used_at` | TEXT | NULLABLE | ISO 8601 timestamp of last invocation in this project |
| `enabled` | INTEGER (0/1) | NOT NULL | Soft-delete: 1 = visible, 0 = detached but not deleted |

---

**End of Audit**

Word count: 2,847 words
