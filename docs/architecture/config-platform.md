# CLEO Config Platform Architecture Document

## Sitar-to-CLEO Mapping

### Preamble

This document designs a configuration management platform for CLEO, inspired by Airbnb's Sitar system. Sitar operates at cloud scale with thousands of services; CLEO operates at local-first CLI scale with AI agents. The mapping preserves Sitar's architectural rigor -- typed schemas, staged rollouts, separated control/data planes, emergency bypass, audit trails -- while adapting every concept to CLEO's CLI-only, local-first, agent-driven world.

```
+====================================================================+
|                    SITAR-TO-CLEO CONCEPTUAL MAP                     |
+====================================================================+
|                                                                     |
|  Sitar (Cloud)              CLEO (Local-First CLI)                  |
|  -------------              ------------------------                 |
|  GitHub PR + Web Portal --> cleo config set / config.json + git     |
|  Tenants (by theme)     --> Config Domains (10 canonical domains)   |
|  Control Plane          --> Config Orchestrator (core/config/)      |
|  Data Plane             --> config.db (SQLite, versioned)           |
|  Sidecar Agent          --> @cleocode/runtime config watcher        |
|  Staged Rollout         --> Scope progression (agent>project>global) |
|  Emergency Bypass       --> --emergency flag with audit trail       |
|  Config-as-Code         --> .cleo/config.json + CI validation       |
|  Feature Flags          --> Config flag resolver (LAFS integration) |
|                                                                     |
+====================================================================+
```

---

## A. Config Tenants and Domains

### What Sitar Does
Configs are grouped into "tenants" organized by theme. Each tenant has owners, custom tests, and dedicated CD pipelines.

### What Exists in CLEO Today
- 10 canonical domains: `tasks`, `session`, `memory`, `check`, `pipeline`, `orchestrate`, `tools`, `admin`, `nexus`, `sticky`, `conduit`
- `CleoConfig` interface in `packages/contracts/src/config.ts` already groups config by theme: `output`, `backup`, `hierarchy`, `session`, `enforcement`, `verification`, `lifecycle`, `logging`, `sharing`, `signaldock`, `brain`
- Config engine in `packages/core/src/config.ts` with cascade resolution

### What Needs to Be Built

**Config Tenants** map to CLEO "Config Domains" -- each domain owns a slice of the configuration namespace:

```
Config Domain           Canonical Domain(s)    Config Sections Owned
--------------------    --------------------    -------------------------
task-enforcement        tasks                  hierarchy, enforcement.acceptance
session-rules           session                session, enforcement.session
agent-behavior          orchestrate, tools     signaldock, agentDefaults (NEW)
lifecycle-pipeline      pipeline, check        lifecycle, verification
brain-memory            memory                 brain, memoryBridge
output-display          admin                  output, logging
security-access         admin                  sharing, accessControl (NEW)
```

Each Config Domain gets:
- **An owner field**: which agent role or user is authoritative
- **A schema**: typed validation rules (extends existing `CleoConfig`)
- **A test hook**: optional validation function run before applying changes
- **A rollout scope**: where changes propagate (project, global, agent-specific)

### Where It Lives
- New type: `packages/contracts/src/config-tenant.ts`
- Domain-to-tenant mapping: `packages/core/src/config/tenant-registry.ts`
- Tenant metadata stored in: `config.db` (new SQLite DB -- see Section D)

### Integration Points
- The dispatch registry already defines canonical domains. Config tenants reference these same domain names.
- The existing `OPERATIONS` array gets new entries for per-tenant config queries.

```
+----------------------------------------------------------+
|                CONFIG TENANT REGISTRY                     |
+----------------------------------------------------------+
|                                                           |
|  tenant: "task-enforcement"                               |
|    domains: [tasks]                                       |
|    schema:  HierarchyConfig + AcceptanceEnforcementConfig |
|    owner:   "planner" | "user"                            |
|    tests:   [maxDepthRange, siblingLimit]                  |
|                                                           |
|  tenant: "lifecycle-pipeline"                             |
|    domains: [pipeline, check]                             |
|    schema:  LifecycleConfig + VerificationConfig          |
|    owner:   "qa" | "user"                                 |
|    tests:   [gateOrderValid, roundLimit]                  |
|                                                           |
|  tenant: "agent-behavior"                                 |
|    domains: [orchestrate, tools]                          |
|    schema:  SignalDockConfig + AgentDefaultsConfig         |
|    owner:   "cleo-prime" | "user"                         |
|    tests:   [endpointReachable, prefixValid]              |
|                                                           |
+----------------------------------------------------------+
```

---

## B. Schema Validation Layer

### What Sitar Does
Strong schema validation for all config changes. Prevents invalid configurations from being applied.

### What Exists in CLEO Today
- 4-layer verification gates: Schema, Semantic, Referential, Protocol
- Validation engine with `ValidationResult` type
- 6 workflow gates: implemented, testsPassed, qaPassed, cleanupDone, securityPassed, documented
- Verification gates middleware

### What Needs to Be Built

A **Config Validation Pipeline** that mirrors the existing 4-layer verification pattern:

```
Config Change Request
        |
        v
+----------------+    Layer 1: CONFIG SCHEMA VALIDATION
| Type checking   |    - TypeScript interface conformance (CleoConfig)
| Range bounds    |    - Enum membership (OutputFormat, LogLevel, etc.)
| Required fields |    - Field length/range constraints
+---------+------+
          |
          v
+---------+------+    Layer 2: CONFIG SEMANTIC VALIDATION
| Cross-field    |    - hierarchy.maxDepth must be >= 1
| consistency    |    - verification.requiredGates must reference valid gate names
| Business rules |    - lifecycle.mode='strict' requires verification.enabled=true
+--------+-------+
         |
         v
+--------+-------+    Layer 3: CONFIG REFERENTIAL VALIDATION
| DB references  |    - signaldock.endpoint must be reachable (optional, warn-only)
| External deps  |    - brain.embedding.provider references valid provider
| Tenant owners  |    - Changing tenant-owned keys requires owner identity
+--------+-------+
         |
         v
+--------+-------+    Layer 4: CONFIG PROTOCOL VALIDATION
| LAFS compat    |    - Config version compatibility
| Migration safe |    - Backward-compatible with previous config.db versions
| Rollback safe  |    - Change can be safely rolled back
+--------+-------+
         |
         v
    APPLY CONFIG
```

### Where It Lives
- `packages/core/src/config/validation/` -- new directory
  - `schema-validator.ts` -- Layer 1 (Zod schemas)
  - `semantic-validator.ts` -- Layer 2 (cross-field business rules)
  - `referential-validator.ts` -- Layer 3 (external reference checks)
  - `protocol-validator.ts` -- Layer 4 (version compat, migration safety)
  - `pipeline.ts` -- composes all 4 layers

### Integration
- Plugs into the existing verification gates middleware as a new gate category
- Config validation adds a `configValid` check that runs before `implemented`
- Reuses existing `ValidationResult` and `ValidationError` types

---

## C. Control Plane

### What Sitar Does
Orchestrates config rollouts: schema validation, ownership, access control, rollout strategy, rollback procedures.

### What Exists in CLEO Today
- `loadConfig()`, `getConfigValue()`, `setConfigValue()` in core
- Config engine with `configGet`, `configSet`, `configSetPreset`
- Strictness presets: `strict`, `standard`, `minimal`

### What Needs to Be Built

A **Config Control Plane** that sits between the CLI command and the config store:

```
+===================================================================+
|                     CONFIG CONTROL PLANE                           |
|                (packages/core/src/config/control-plane.ts)         |
+===================================================================+
|                                                                    |
|  cleo config set <key> <value>                                     |
|         |                                                          |
|         v                                                          |
|  1. RESOLVE TENANT                                                 |
|     - Which config domain owns this key?                           |
|     - Who is the tenant owner?                                     |
|     - Is current actor authorized?                                 |
|         |                                                          |
|         v                                                          |
|  2. VALIDATE (4-layer pipeline from Section B)                     |
|     - Schema, semantic, referential, protocol                      |
|     - Returns ValidationResult                                     |
|         |                                                          |
|         v                                                          |
|  3. SNAPSHOT CURRENT STATE                                         |
|     - Read current config.db version                               |
|     - Create rollback point (config version N)                     |
|         |                                                          |
|         v                                                          |
|  4. APPLY TO TARGET SCOPE                                          |
|     - project (default) | global | agent-specific                  |
|     - Write to config.db with new version N+1                      |
|         |                                                          |
|         v                                                          |
|  5. VERIFY NO REGRESSIONS (optional, --verify flag)                |
|     - Run tenant test hooks                                        |
|     - Check config consistency across scopes                       |
|         |                                                          |
|         v                                                          |
|  6. COMMIT AUDIT RECORD                                            |
|     - Write to config_audit table in config.db                     |
|     - Include: who, what, when, from-value, to-value, version      |
|         |                                                          |
|         v                                                          |
|  7. NOTIFY RUNTIME (if active)                                     |
|     - Emit config-changed event via EventEmitter                   |
|     - Runtime services pick up change on next poll cycle            |
|                                                                    |
+===================================================================+
```

### Where It Lives
- `packages/core/src/config/control-plane.ts` -- orchestration logic
- `packages/core/src/config/rollback.ts` -- rollback mechanism
- `packages/core/src/config/access-control.ts` -- tenant ownership checks

### Integration
- The config engine calls the control plane instead of directly calling `setConfigValue()`
- The existing audit middleware audits config mutations automatically

---

## D. Data Plane / Config Store

### What Sitar Does
Scalable storage + efficient distribution. Source of truth for config values and versions.

### What Exists in CLEO Today
- 3 SQLite DBs: `tasks.db`, `brain.db`, `nexus.db` (all via Drizzle ORM)
- Config stored as JSON files: `.cleo/config.json` (project), global config
- No config versioning, no change history, no rollback

### What Needs to Be Built

**A new `config.db` SQLite database** -- the 4th CLEO database (tasks=tasks, signaldock=agents, brain=memory, **config=configuration**).

```
TABLE: config_entries
+------------------+----------+------------------------------------+
| Column           | Type     | Description                        |
+------------------+----------+------------------------------------+
| id               | TEXT PK  | UUID                               |
| key              | TEXT     | Dot-notation path                  |
| value_json       | TEXT     | JSON-encoded value                 |
| scope            | TEXT     | 'project' | 'global' | 'agent:{id}'|
| tenant           | TEXT     | Config domain name                 |
| version          | INTEGER  | Monotonic version counter          |
| created_at       | TEXT     | ISO timestamp                      |
| created_by       | TEXT     | Actor (agent ID or 'user')         |
| superseded_by    | TEXT     | FK to replacing entry (null=current|
| is_current       | INTEGER  | 1 if active version                |
| emergency        | INTEGER  | 1 if set via --emergency bypass    |
+------------------+----------+------------------------------------+
UNIQUE INDEX: (key, scope, is_current) WHERE is_current = 1

TABLE: config_audit
+------------------+----------+------------------------------------+
| Column           | Type     | Description                        |
+------------------+----------+------------------------------------+
| id               | TEXT PK  | UUID                               |
| config_entry_id  | TEXT FK  | References config_entries.id       |
| action           | TEXT     | 'set'|'rollback'|'emergency'|etc.  |
| old_value_json   | TEXT     | Previous value (null if first set) |
| new_value_json   | TEXT     | New value                          |
| old_version      | INTEGER  | Previous version number            |
| new_version      | INTEGER  | New version number                 |
| actor            | TEXT     | Who made the change                |
| session_id       | TEXT     | Active CLEO session (soft FK)      |
| reason           | TEXT     | Human-readable reason              |
| validation_result| TEXT     | JSON of validation output          |
| timestamp        | TEXT     | ISO timestamp                      |
| emergency        | INTEGER  | 1 if bypass was used               |
+------------------+----------+------------------------------------+

TABLE: config_flags
+------------------+----------+------------------------------------+
| Column           | Type     | Description                        |
+------------------+----------+------------------------------------+
| id               | TEXT PK  | UUID                               |
| flag_name        | TEXT     | Unique flag identifier             |
| description      | TEXT     | What this flag controls            |
| enabled          | INTEGER  | Global on/off                      |
| scope_overrides  | TEXT     | JSON: per-scope overrides          |
| percentage       | INTEGER  | Rollout % (0-100)                  |
| metadata_json    | TEXT     | Arbitrary metadata                 |
| created_at       | TEXT     | ISO timestamp                      |
| updated_at       | TEXT     | ISO timestamp                      |
| expires_at       | TEXT     | Auto-expire (null = permanent)     |
+------------------+----------+------------------------------------+
UNIQUE INDEX: (flag_name)

TABLE: config_snapshots
+------------------+----------+------------------------------------+
| Column           | Type     | Description                        |
+------------------+----------+------------------------------------+
| id               | TEXT PK  | UUID                               |
| snapshot_name    | TEXT     | Human label                        |
| scope            | TEXT     | Which scope was snapshot           |
| entries_json     | TEXT     | Full JSON dump of all entries      |
| created_at       | TEXT     | ISO timestamp                      |
| created_by       | TEXT     | Actor                              |
+------------------+----------+------------------------------------+
```

### Version Mechanism

Append-only log pattern: old entries get `is_current = 0` and `superseded_by` pointing to the new entry. Provides:
- **Full audit trail**: every value ever set is preserved
- **Instant rollback**: flip `is_current` flags
- **Version diffing**: compare any two versions of a key

### Backward Compatibility with config.json

Existing `config.json` files become **materialized views** of config.db:

```
config.db (source of truth)
    |
    +---> .cleo/config.json (materialized, project scope)
    |
    +---> ~/.local/share/cleo/config.json (materialized, global scope)
```

On every config.db write, the control plane regenerates config.json from all `is_current = 1` entries.

---

## E. Config Distribution (Local-First Sidecar Equivalent)

### What Sitar Does
Language-agnostic sidecar agent per service with local disk cache.

### What Needs to Be Built

A **ConfigWatcher** service in `@cleocode/runtime`:

```
+====================================================================+
|              CONFIG DISTRIBUTION ARCHITECTURE                       |
+====================================================================+
|                                                                     |
|  CLI Command (short-lived)         Runtime (long-lived)             |
|  -------------------------         ------------------               |
|                                                                     |
|  cleo config set ...               ConfigWatcher service            |
|       |                                  |                          |
|       v                                  | polls config.db every    |
|  control-plane.ts                        | N seconds (default: 10)  |
|       |                                  |                          |
|       v                                  v                          |
|  config.db (write)        ------->  config.db (read version)        |
|       |                                  |                          |
|       v                                  | if version > cached:     |
|  emit config-changed                     |   reload from disk       |
|  event (node:events)                     |   notify subscribers     |
|                                          |                          |
|                              +-----------+-----------+              |
|                              |           |           |              |
|                              v           v           v              |
|                          AgentPoller  Heartbeat  SSE Service        |
|                          (re-reads   (adjusts   (reconnects         |
|                           interval)   timing)    if endpoint        |
|                                                  changed)           |
|                                                                     |
|  CACHE LAYER (resilient to DB issues)                               |
|  .cleo/config-cache.json                                            |
|    - Written on every successful config load                        |
|    - Read as fallback when config.db is locked/corrupted            |
|    - Includes version number for staleness detection                |
|                                                                     |
+====================================================================+
```

### Where It Lives
- `packages/runtime/src/services/config-watcher.ts`
- `packages/core/src/config/cache.ts` -- disk cache read/write

---

## F. Staged Rollout (Local-First Equivalent)

For a local-first CLI, "staged rollout" maps to **scope progression**:

```
STAGE 1: DRY RUN (--dry-run)
    - Validate against all 4 layers
    - Show diff, NO write

STAGE 2: SINGLE AGENT (--scope agent:<id>)
    - Apply for one specific agent
    - Other agents continue with previous config

STAGE 3: PROJECT SCOPE (--scope project)  [DEFAULT]
    - Apply to current project
    - All agents in this project see the change

STAGE 4: GLOBAL SCOPE (--scope global)
    - Apply to all projects on this machine
    - Requires explicit --global flag

ROLLBACK: Any stage can revert independently
    - cleo config rollback <key> --scope <scope>
```

**Promotion command:**
```
cleo config promote <key> --from agent:coder --to project
```

Resolution order (unchanged, but now versioned):
```
agent:{id} override > CLI flags > env vars > project > global > defaults
```

---

## G. Emergency Bypass

```
cleo config set <key> <value> --emergency --reason "incident: agent loop detected"

  1. Skip ALL 4 validation layers
  2. Skip tenant ownership check
  3. Write directly to config.db with emergency=1
  4. Write config_audit record (action='emergency', reason=required)
  5. Regenerate config.json
  6. Emit config-changed event
  7. Log WARNING

  Constraints:
  - --reason is REQUIRED (min 10 chars)
  - Emergency changes flagged in config_entries
  - Auto-expire after 24 hours unless confirmed: cleo config confirm <key>
  - cleo config audit --emergency-only shows all bypass events
```

---

## H. Config-as-Code Pipeline

```
+====================================================================+
|               CONFIG-AS-CODE PIPELINE                               |
+====================================================================+
|                                                                     |
|  cleo config set hierarchy.maxDepth 5                               |
|       |                                                             |
|       v                                                             |
|  Control Plane (validate + write config.db + regen config.json)     |
|       |                                                             |
|       v                                                             |
|  .cleo/config.json modified on disk                                 |
|       |                                                             |
|       v                                                             |
|  git add .cleo/config.json && git commit                            |
|       |                                                             |
|       v                                                             |
|  Pull Request                                                       |
|       |                                                             |
|       v                                                             |
|  CI: config-validate job (NEW GitHub Action step)                   |
|       +-- 1. pnpm cleo config validate                              |
|       +-- 2. pnpm cleo config diff --base main                     |
|       +-- 3. pnpm cleo doctor                                      |
|       |                                                             |
|       v                                                             |
|  Merge -> config.json lands in main                                 |
|       |                                                             |
|       v                                                             |
|  Next cleo invocation: loadConfig() auto-syncs config.json->config.db|
|                                                                     |
+====================================================================+
```

### Config Import (config.json to config.db sync)
When `loadConfig()` detects that config.json has entries not yet in config.db (e.g., from a git pull), it imports them with `created_by = 'git-sync'`.

---

## I. Feature Flags

Stored in `config_flags` table:

```
FLAG RESOLUTION ORDER:
  1. Agent-specific override (scope_overrides["agent:coder"] = true)
  2. Project-specific override (scope_overrides["project"] = true)
  3. Global flag value (enabled column)
  4. Percentage rollout (random seed per agent ID, stable)

EXAMPLE FLAGS:
  experimental.warp-chain-v2     -- New chain execution engine
  experimental.brain-embeddings  -- Semantic memory embeddings
  experimental.hot-reload        -- Config hot-reload in runtime
  agent.coder.auto-verify       -- Auto-run tests on complete
  agent.qa.strict-review        -- QA agent blocks on warnings

FLAG LIFECYCLE:
  1. Create: cleo config flag create <name> --description "..."
  2. Enable: cleo config flag enable <name> [--scope agent:X]
  3. Rollout: cleo config flag set-percentage <name> 50
  4. Promote: cleo config flag enable <name> --scope global
  5. Expire: cleo config flag expire <name> --at "2026-05-01"
  6. Remove: cleo config flag delete <name>
```

### Flag Resolver API
```typescript
isEnabled(flagName: string, context: FlagContext): boolean
getAllFlags(scope?: string): FlagEntry[]
```

---

## J. New CLI Commands

### Core Config (extend existing)
```
cleo config set <key> <value>
    [--scope project|global|agent:<id>]
    [--dry-run]
    [--emergency --reason "..."]
    [--promote-from <scope>]

cleo config get <key>
    [--scope ...] [--with-source] [--version N]
```

### Versioning & Rollback
```
cleo config history <key> [--limit N] [--scope ...]
cleo config rollback <key> [--to-version N] [--scope ...]
cleo config snapshot create <name>
cleo config snapshot list
cleo config snapshot restore <name>
```

### Validation
```
cleo config validate [--layer schema|semantic|referential|protocol] [--fix]
cleo config diff [--base main] [--scope ...]
```

### Feature Flags
```
cleo config flag create <name> --description "..."
cleo config flag enable <name> [--scope ...]
cleo config flag disable <name> [--scope ...]
cleo config flag set-percentage <name> <N>
cleo config flag list [--enabled-only]
cleo config flag delete <name>
```

### Promotion & Audit
```
cleo config promote <key> --from <scope> --to <scope>
cleo config audit [--key ...] [--emergency-only] [--limit N] [--since <date>]
cleo config confirm <key>
```

---

## K. New Contract Types

### packages/contracts/src/config-tenant.ts
```typescript
ConfigTenant {
  name: string
  description: string
  domains: CanonicalDomain[]
  configPaths: string[]
  owner: string
  testHooks: string[]
}
ConfigTenantRegistry = Record<string, ConfigTenant>
```

### packages/contracts/src/config-versioning.ts
```typescript
ConfigScope = 'project' | 'global' | `agent:${string}`
ConfigEntry { id, key, valueJson, scope, tenant, version, createdAt, createdBy, supersededBy, isCurrent, emergency }
ConfigAuditRecord { id, configEntryId, action, oldValueJson, newValueJson, oldVersion, newVersion, actor, sessionId, reason, validationResultJson, timestamp, emergency }
ConfigAuditAction = 'set' | 'rollback' | 'emergency' | 'preset' | 'migrate' | 'promote' | 'flag-change'
ConfigSnapshot { id, name, scope, entriesJson, createdAt, createdBy }
```

### packages/contracts/src/config-flags.ts
```typescript
FeatureFlag { id, flagName, description, enabled, scopeOverrides, percentage, metadataJson, createdAt, updatedAt, expiresAt }
FlagContext { agentId?, projectId?, scope? }
FlagResolution { flagName, enabled, source }
```

### packages/contracts/src/config-validation.ts
```typescript
ConfigValidationLayer = 'schema' | 'semantic' | 'referential' | 'protocol'
ConfigValidationResult { valid, layer, errors, warnings, autoFixable }
ConfigAutoFix { key, currentValue, suggestedValue, reason }
ConfigDiff { key, scope, currentValue, proposedValue, tenant, validationResult }
```

### packages/contracts/src/config-control-plane.ts
```typescript
ConfigSetOptions { key, value, scope, dryRun, emergency, reason?, actor, sessionId? }
ConfigMutationResult { success, entry, audit, validation, materialized }
ConfigPromoteOptions { key, fromScope, toScope, actor }
```

### Addition to existing config.ts
```typescript
ConfigPlatformSettings {
  versioningEnabled: boolean
  emergencyExpiryHours: number  // default: 24
  gitSyncEnabled: boolean       // default: true
  watcherIntervalMs: number     // default: 10000
  flagsEnabled: boolean         // default: false
}
```

---

## L. New Middleware

### config-gate.ts
Intercepts config mutations and routes through the control plane. Triggers on `domain='admin' AND operation starts with 'config.'`.

### flag-resolver.ts
Resolves feature flags and attaches to request context as `req._flags`. Runs on ALL requests (lightweight, reads from cache).

### config-scope-resolver.ts
Resolves effective config scope for the current request. Checks for agent-specific overrides.

### Updated Pipeline
```
CURRENT:  sanitizer -> session-resolver -> rate-limiter -> verification-gates
          -> protocol-enforcement -> field-filter -> audit -> [handler]

NEW:      sanitizer -> flag-resolver -> config-scope-resolver -> session-resolver
          -> rate-limiter -> config-gate -> verification-gates
          -> protocol-enforcement -> field-filter -> projection -> audit -> [handler]
```

---

## Complete Package Map

```
packages/contracts/src/
  NEW  config-tenant.ts
  NEW  config-versioning.ts
  NEW  config-flags.ts
  NEW  config-validation.ts
  NEW  config-control-plane.ts
  MOD  config.ts                     Add ConfigPlatformSettings
  MOD  index.ts                      Re-export new modules

packages/core/src/
  NEW  config/control-plane.ts       Config orchestration
  NEW  config/rollback.ts            Rollback mechanism
  NEW  config/access-control.ts      Tenant ownership checks
  NEW  config/rollout.ts             Staged rollout / promote
  NEW  config/dry-run.ts             Dry-run diff generation
  NEW  config/emergency.ts           Emergency bypass + auto-expiry
  NEW  config/flags.ts               Feature flag resolution engine
  NEW  config/git-sync.ts            Bidirectional config.json <-> config.db sync
  NEW  config/cache.ts               Disk cache for config resilience
  NEW  config/tenant-registry.ts     Config domain -> tenant mapping
  NEW  config/validation/
         schema-validator.ts         Layer 1
         semantic-validator.ts       Layer 2
         referential-validator.ts    Layer 3
         protocol-validator.ts       Layer 4
         pipeline.ts                 Composes all 4 layers
  NEW  store/config-schema.ts        Drizzle schema for config.db
  NEW  store/config-sqlite.ts        DB init, getConfigDb()
  NEW  config/store.ts               Read/write ops against config.db
  MOD  config.ts                     loadConfig() calls git-sync
  MOD  paths.ts                      Add getConfigDbPath()

packages/cleo/src/
  NEW  dispatch/middleware/config-gate.ts
  NEW  dispatch/middleware/flag-resolver.ts
  NEW  dispatch/middleware/config-scope-resolver.ts
  MOD  dispatch/engines/config-engine.ts
  MOD  dispatch/registry.ts          16+ new operation entries
  MOD  dispatch/dispatcher.ts        Updated middleware pipeline
  NEW  cli/commands/config/
         index.ts                    Register all subcommands
         core.ts                     get, set, list (migrated)
         versioning.ts               history, rollback, snapshot
         flags.ts                    flag subcommands
         validation.ts               validate, diff
         audit.ts                    audit, emergency confirm
         promote.ts                  promote between scopes

packages/runtime/src/
  NEW  services/config-watcher.ts    Config change polling service
  MOD  index.ts                      Add ConfigWatcher to RuntimeHandle

.github/workflows/
  MOD  ci.yml                        Add config-validate step
```

---

## Migration Strategy

### Phase 1: Foundation (config.db + contracts)
1. Add new contract types to `@cleocode/contracts`
2. Create Drizzle schema in core/store
3. Create DB initialization with `getConfigDb()`
4. Add `getConfigDbPath()` to paths.ts
5. Run Drizzle migration

### Phase 2: Control Plane (validation + versioning)
1. Build 4-layer validation pipeline
2. Build control plane orchestrator
3. Build rollback mechanism
4. Build git-sync module
5. Modify `loadConfig()` to trigger git-sync

### Phase 3: CLI Surface (commands + middleware)
1. Split config commands into directory
2. Add new dispatch registry operations
3. Build config-gate middleware
4. Wire new middleware into pipeline
5. Extend `cleo doctor` with config health checks

### Phase 4: Feature Flags
1. Build flag resolver
2. Build flag-resolver middleware
3. Add `cleo config flag` CLI subcommands
4. Integrate with existing LAFS flag infrastructure

### Phase 5: Runtime Distribution
1. Build ConfigWatcher service
2. Integrate into RuntimeHandle
3. Build disk cache fallback
4. Wire runtime services to config change events

### Phase 6: Staged Rollout + Emergency
1. Build rollout / promote logic
2. Build emergency bypass path
3. Add CI validation job
4. End-to-end testing

---

## Trade-off Analysis

| Decision | Alternative | Rationale |
|----------|------------|-----------|
| New config.db (4th SQLite DB) | Extend tasks.db | Separation of concerns -- config lifecycle differs from tasks |
| Append-only log in config_entries | Mutable rows + history table | Simpler rollback, immutable audit trail |
| config.json as materialized view | Abandon config.json | Backward compat, git-committable, human-readable |
| Flag resolver as middleware | Flag checking in domain handlers | Consistent availability, single cache point |
| Emergency bypass with auto-expiry | Permanent emergency overrides | Prevents forgotten overrides |
| Tenant ownership by agent role | ACL-based per-key permissions | Simpler for local-first CLI |
| Per-key version counters | Single global counter | Granular rollback, lower contention |

---

## Dependency Graph

```
                    @cleocode/contracts
                   (pure types, no deps)
                          |
              +-----------+-----------+
              |                       |
        @cleocode/core          @cleocode/lafs
        (config.db,              (flag semantics,
         control plane,           protocol flags)
         validation,
         flags engine)
              |
     +--------+--------+
     |                  |
@cleocode/cleo    @cleocode/runtime
(CLI commands,     (ConfigWatcher,
 middleware,        hot-reload,
 dispatch)         cache)
     |
@cleocode/adapters
(adapter-specific
 config overrides)
```

No new packages. All new code extends existing packages.
