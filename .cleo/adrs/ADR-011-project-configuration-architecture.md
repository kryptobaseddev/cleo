# ADR-011: Project Configuration Architecture

**Date**: 2026-02-23
**Status**: accepted
**Amends**: ADR-006 (Section 1)

## 1. Context and Motivation

CLEO maintains three JSON configuration files in the `.cleo/` directory. Each serves a distinct purpose, but no canonical document describes the complete ecosystem: what each file contains, which modules read and write it, how files are created and maintained, how staleness is detected, and how `project-context.json` reaches LLM agents.

ADR-006 established SQLite as the canonical storage engine and listed `config.json` and `project-info.json` as JSON-exempt files, but omitted `project-context.json`. This ADR fills that gap by serving as the definitive reference for the entire project configuration system and formally amending ADR-006 to include the missing file.

## 2. Decision

CLEO SHALL maintain exactly three JSON configuration files in the `.cleo/` directory, each with a single, non-overlapping responsibility:

| File | Responsibility |
|------|---------------|
| `config.json` | Runtime behavior settings |
| `project-info.json` | Project metadata and schema version registry |
| `project-context.json` | LLM agent guidance and framework detection |

The following requirements apply:

1. All three files are exempt from ADR-006's SQLite-only storage mandate. They are human-editable, git-tracked configuration files per ADR-006 Section 1.
2. Each file MUST have a corresponding JSON Schema in `.cleo/schemas/`.
3. No file SHALL duplicate the responsibilities of another. Runtime behavior MUST NOT appear in `project-info.json`. Schema version tracking MUST NOT appear in `config.json`. LLM guidance MUST NOT appear in either of the other two.
4. All write operations to these files MUST use atomic file operations (`saveJson()` via `src/store/json.ts`) to prevent corruption.

## 3. The Configuration File Ecosystem

### 3.1 `config.json` -- Runtime Behavior Configuration

**Purpose**: Controls how CLEO behaves at runtime -- output formatting, backup retention, hierarchy limits, session rules, release gates, lifecycle enforcement mode, and storage engine selection.

**Locations**:
- Project: `.cleo/config.json`
- Global: `~/.cleo/config.json`

**Schema**: `.cleo/schemas/config.schema.json` (v2.10.0, `$id`: `claude-todo-config-schema-v2.1`)

**Fields**:

| Key | Type | Purpose |
|-----|------|---------|
| `_meta` | object | Schema version, timestamps (`schemaVersion`, `createdAt`, `updatedAt`) |
| `project` | object | Project name and current phase |
| `multiSession` | object | Concurrency controls: `enabled`, `maxConcurrentSessions`, `maxActiveTasksPerScope`, `scopeValidation`, `enforcement` |
| `retention` | object | Session timeout: `autoEndActiveAfterDays`, `sessionTimeoutWarningHours` |
| `session` | object | Session enforcement mode (`advisory`/`strict`/`off`), `maxConcurrent` |
| `release` | object | Release gates, version bump file targets, changelog config |
| `hierarchy` | object | `maxDepth` (default: 3), `maxSiblings` (default: 7) |
| `storage` | object | Storage engine selection (`sqlite`) |
| `version` | string | Config schema version |

**Modules**:

| Module | Access | Functions |
|--------|--------|-----------|
| `src/core/config.ts` | Read/Write | `loadConfig()`, `getConfigValue()`, `getRawConfig()`, `getRawConfigValue()`, `setConfigValue()`, `parseConfigValue()` |
| `src/mcp/engine/config-engine.ts` | Read/Write | `configGet()`, `configSet()` (via `src/dispatch/domains/admin.ts`) |
| `src/core/paths.ts` | Read | Reads `agentOutputs.directory`, `research.outputDir` for path resolution |
| `src/core/init.ts` | Write | Creates default config during `cleo init` |

---

### 3.2 `project-info.json` -- Project Metadata Registry

**Purpose**: Tracks project registration metadata, schema versions of core data files, injection status of LLM agent instruction files, health diagnostics, and feature flags. Part of a hybrid registry where the global registry (`~/.cleo/projects-registry.json`) stores minimal cross-project data and this file stores project-specific details.

**Location**: `.cleo/project-info.json`

**Schema**: `.cleo/schemas/project-info.schema.json` (v1.0.0, `$id`: `https://cleo-dev.com/schemas/v1/project-info.schema.json`)

**Fields**:

| Key | Type | Purpose |
|-----|------|---------|
| `$schema` | string | JSON Schema reference URI |
| `schemaVersion` | string | This file's schema version (semver) |
| `projectHash` | string | 12-char hex SHA-256 prefix of project path; links to global registry |
| `name` | string | Project name |
| `registeredAt` | string | ISO 8601 timestamp of first registration |
| `lastUpdated` | string | ISO 8601 timestamp of last modification |
| `cleoVersion` | string | CLEO version that last modified this file |
| `schemas` | object | Version tracking for core data files: `todo`, `config`, `archive`, `log` |
| `injection` | object | Injection status for `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` (status + timestamp) |
| `health` | object | `status` (healthy/warning/error/unknown), `lastCheck`, `issues[]` |
| `features` | object | Feature toggles: `multiSession`, `verification`, `contextAlerts` |

**Modules**:

| Module | Access | Functions |
|--------|--------|-----------|
| `src/store/project-registry.ts` | Read/Write | `getProjectInfo()`, `saveProjectInfo()`, `getProjectData()` (merges global + local), `generateProjectHash()` |
| `src/core/system/health.ts` | Read/Write | Reads for health checks, writes health status and issues |
| `src/core/init.ts` | Write | `initProjectInfo()` creates during `cleo init` |
| `src/core/upgrade.ts` | Read/Write | Updates during version upgrades |

**Hybrid Registry Architecture**:

```
~/.cleo/projects-registry.json          .cleo/project-info.json
┌─────────────────────────────┐         ┌──────────────────────────┐
│ Global: minimal per-project │         │ Local: detailed metadata │
│ - projectHash               │ ◄─────► │ - projectHash (link key) │
│ - path                      │         │ - schemas{}              │
│ - registeredAt              │         │ - injection{}            │
│ - lastAccessed              │         │ - health{}               │
└─────────────────────────────┘         │ - features{}             │
                                        └──────────────────────────┘

getProjectData() merges both; local takes precedence on conflicts.
```

---

### 3.3 `project-context.json` -- LLM Agent Guidance

**Purpose**: Provides framework detection metadata and LLM-specific guidance so that AI coding agents understand the project's language, test framework, package manager, and conventions without reading build files directly. This file is the ONLY mechanism by which CLEO communicates project characteristics to LLM agents.

**Location**: `.cleo/project-context.json`

**Schema**: `.cleo/schemas/project-context.schema.json` (v1.0.0, `$id`: `https://cleo-dev.com/schemas/v1/project-context.schema.json`)

**Actual Fields** (as produced by `detectProjectType()`):

| Key | Type | Purpose |
|-----|------|---------|
| `type` | string | Detected project type: `node`, `python`, `rust`, `go`, `ruby`, `java`, `dotnet`, `bash`, `unknown` |
| `testFramework` | string | Detected test framework: `jest`, `vitest`, `mocha`, `pytest`, `bats`, `cargo-test`, `go-test`, `rspec`, `junit`, `unknown` |
| `hasTypeScript` | boolean | Whether `tsconfig.json` exists |
| `packageManager` | string | `npm`, `yarn`, `pnpm`, or `bun` (Node.js projects only) |
| `monorepo` | boolean | Whether monorepo markers exist (`lerna.json`, `pnpm-workspace.yaml`, `packages/`) |
| `detectedAt` | string | ISO 8601 timestamp of detection |

**Schema-Defined but Not Yet Populated**:

The schema supports richer fields that `detectProjectType()` does not currently populate:

| Key | Type | Purpose |
|-----|------|---------|
| `schemaVersion` | string | Schema version (semver) |
| `projectTypes` | string[] | All detected project types (multi-language support) |
| `primaryType` | string | Primary project type |
| `testing` | object | `framework`, `command`, `testFilePatterns`, `directories` (unit/integration) |
| `build` | object | `command`, `outputDir` |
| `directories` | object | `source`, `tests`, `docs` |
| `conventions` | object | `fileNaming`, `importStyle`, `typeSystem` |
| `llmHints` | object | `preferredTestStyle`, `typeSystem`, `commonPatterns[]`, `avoidPatterns[]` |

**Modules**:

| Module | Access | Functions |
|--------|--------|-----------|
| `src/store/project-detect.ts` | Read (filesystem) | `detectProjectType()` -- examines filesystem markers |
| `src/core/init.ts` | Write | `initProjectDetect()` -- creates file during `cleo init --detect` |
| `src/core/upgrade.ts` | Read/Write | 30-day staleness check and refresh during `cleo upgrade` |
| Agent instruction files | Read (via `@` reference) | `@.cleo/project-context.json` in `~/.cleo/templates/AGENT-INJECTION.md` |

**Detection Logic** (from `src/store/project-detect.ts`):

```
Node.js:    package.json exists
  ├─ TypeScript: tsconfig.json
  ├─ Package mgr: yarn.lock → yarn | pnpm-lock.yaml → pnpm | bun.lockb → bun | default: npm
  ├─ Monorepo: lerna.json | pnpm-workspace.yaml | packages/
  └─ Tests: vitest.config.* → vitest | jest.config.* → jest | .mocharc.* → mocha

Python:     pyproject.toml | setup.py | requirements.txt → pytest
Rust:       Cargo.toml → cargo-test
Go:         go.mod → go-test
Ruby:       Gemfile → rspec
Java:       pom.xml | build.gradle* → junit
.NET:       *.csproj | *.sln
Bash:       tests/ + install.sh → bats (if tests/unit or tests/integration exists)
```

## 4. File Relationship Model

```
                    ┌────────────────────────────┐
                    │         cleo init           │
                    │      (src/core/init.ts)     │
                    └─────┬──────┬──────┬────────┘
                          │      │      │
              ┌───────────┘      │      └───────────┐
              ▼                  ▼                   ▼
    ┌──────────────────┐  ┌──────────────┐  ┌───────────────────┐
    │   config.json    │  │ project-     │  │ project-          │
    │                  │  │ info.json    │  │ context.json      │
    │ "How CLEO runs"  │  │ "What CLEO   │  │ "What agents      │
    │                  │  │  knows about │  │  should know       │
    │ Runtime behavior │  │  this project"│  │  about this       │
    │ settings         │  │              │  │  project"          │
    └────────┬─────────┘  └──────┬───────┘  └──────┬────────────┘
             │                   │                  │
             │    ┌──────────────┘                  │
             │    │ schemas{} tracks                │
             │    │ version of config.json          │
             │    │                                 │
             ▼    ▼                                 ▼
    ┌──────────────────┐               ┌────────────────────────┐
    │  src/core/        │               │ Agent Instruction      │
    │  config.ts        │               │ Files (CLAUDE.md, etc) │
    │  (cascade         │               │                        │
    │   resolution)     │               │ @.cleo/project-        │
    └──────────────────┘               │  context.json          │
                                       └────────────────────────┘
```

Key relationships:
- `project-info.json` tracks the schema version of `config.json` (via `schemas.config`)
- `project-info.json` does NOT track schema versions for itself or `project-context.json`
- `config.json` has a cascade resolution (defaults < global < project < env vars); the other two do not
- `project-context.json` is the only file consumed by LLM agents through the injection chain

## 5. Lifecycle and Ownership

### 5.1 Creation

All three files are created during `cleo init` (via `src/core/init.ts`):

| File | Init Function | Condition |
|------|--------------|-----------|
| `config.json` | `initCoreFiles()` | Always created with defaults |
| `project-info.json` | `initProjectInfo()` | Always created with project hash, schema versions, empty health |
| `project-context.json` | `initProjectDetect()` | Only when `--detect` flag is provided |

### 5.2 Read Paths

| File | Primary Readers |
|------|----------------|
| `config.json` | `loadConfig()` (every CLI/MCP operation), path resolution, release gates |
| `project-info.json` | Health checks (`cleo doctor`), upgrade operations, project registry queries |
| `project-context.json` | LLM agents (via `@` reference injection at runtime) |

### 5.3 Write Paths

| File | Writers | Trigger |
|------|---------|---------|
| `config.json` | `setConfigValue()` | User runs `cleo config set`, MCP `admin.config.set` |
| `project-info.json` | `saveProjectInfo()` | Health checks, init, upgrade, injection updates |
| `project-context.json` | `initProjectDetect()` | `cleo init --detect`, `cleo upgrade` (staleness refresh) |

### 5.4 Staleness Detection and Refresh

| File | Staleness Mechanism | Threshold | Trigger |
|------|-------------------|-----------|---------|
| `config.json` | None (user-managed) | N/A | User edits intentionally |
| `project-info.json` | None | N/A | Updated by CLEO operations |
| `project-context.json` | `detectedAt` timestamp check | 30 days | `cleo upgrade` (see `src/core/upgrade.ts`) |

The `project-context.json` staleness logic (in `src/core/upgrade.ts`):

```
1. Read detectedAt timestamp from project-context.json
2. Calculate days since detection
3. If > 30 days: re-run detectProjectType() and overwrite with fresh data
4. If <= 30 days: skip (up to date)
5. If file does not exist: create it via detection
```

## 6. Configuration Resolution Cascade

`config.json` is the only file with multi-layer resolution. The cascade is implemented in `src/core/config.ts:loadConfig()`:

```
Priority (lowest → highest):

1. DEFAULTS (hardcoded in src/core/config.ts)
   └─ version: '2.10.0', hierarchy.maxSiblings: 7, lifecycle.mode: 'strict', etc.

2. Global config (~/.cleo/config.json)
   └─ User-wide preferences (e.g., multiSession.enabled, lifecycleEnforcement.mode)

3. Project config (.cleo/config.json)
   └─ Project-specific overrides (e.g., hierarchy.maxSiblings: 60, release.gates)

4. Environment variables (CLEO_* prefix)
   └─ Highest priority, typically for CI/CD or temporary overrides
```

**Environment Variable Mapping** (from `src/core/config.ts`):

| Environment Variable | Config Path |
|---------------------|-------------|
| `CLEO_FORMAT` | `output.defaultFormat` |
| `CLEO_OUTPUT_DEFAULT_FORMAT` | `output.defaultFormat` |
| `CLEO_OUTPUT_SHOW_COLOR` | `output.showColor` |
| `CLEO_OUTPUT_SHOW_UNICODE` | `output.showUnicode` |
| `CLEO_OUTPUT_SHOW_PROGRESS_BARS` | `output.showProgressBars` |
| `CLEO_OUTPUT_DATE_FORMAT` | `output.dateFormat` |
| `CLEO_HIERARCHY_MAX_DEPTH` | `hierarchy.maxDepth` |
| `CLEO_HIERARCHY_MAX_SIBLINGS` | `hierarchy.maxSiblings` |
| `CLEO_SESSION_AUTO_START` | `session.autoStart` |
| `CLEO_SESSION_REQUIRE_NOTES` | `session.requireNotes` |
| `CLEO_LIFECYCLE_MODE` | `lifecycle.mode` |

Source tracking is available via `getConfigValue<T>()`, which returns `ResolvedValue<T>` containing both the value and which layer provided it (`'default'`, `'global'`, `'project'`, or `'env'`).

## 7. Injection Chain for `project-context.json`

The injection chain delivers `project-context.json` content into LLM agent context windows:

```
CLAUDE.md / AGENTS.md / GEMINI.md
│
├── <!-- CLEO:START -->
│   @.cleo/templates/AGENT-INJECTION.md
│   <!-- CLEO:END -->
│
└── .cleo/templates/AGENT-INJECTION.md      (project-local pointer)
    │
    ├── @~/.cleo/templates/CLEO-INJECTION.md  (global CLEO protocol)
    │
    └── ~/.cleo/templates/AGENT-INJECTION.md  (global template, line 98):
        @.cleo/project-context.json           (actual injection point)
```

When an LLM agent loads its instruction file (e.g., CLAUDE.md), the `@` reference chain resolves transitively. The entire JSON content of `project-context.json` is injected verbatim into the agent's context window.

Key behaviors:
- If `project-context.json` does not exist, the `@` reference is silently ignored
- The file content is injected as raw JSON -- agents parse it contextually
- This is the ONLY automated mechanism by which agents learn project type, test framework, and conventions
- Agents MAY also read the file directly via filesystem access

## 8. Schema Inventory

| File | Schema Path | Schema Version | `$id` Format |
|------|-------------|---------------|--------------|
| `config.json` | `.cleo/schemas/config.schema.json` | 2.10.0 (via `version` field) | Local: `claude-todo-config-schema-v2.1` |
| `project-info.json` | `.cleo/schemas/project-info.schema.json` | 1.0.0 | URI: `https://cleo-dev.com/schemas/v1/project-info.schema.json` |
| `project-context.json` | `.cleo/schemas/project-context.schema.json` | 1.0.0 | URI: `https://cleo-dev.com/schemas/v1/project-context.schema.json` |

Note: `config.schema.json` uses a local-style `$id` while the other two use URI-based `$id`s. This is an inconsistency documented in Section 9.

## 9. Identified Gaps and Recommendations

The following gaps were identified during analysis. This ADR documents them; implementation is tracked separately.

### Gap 1: Schema/Implementation Mismatch in `project-context.json`

The schema requires `schemaVersion`, `projectTypes` (array), and `primaryType`, but `detectProjectType()` in `src/store/project-detect.ts` returns a `ProjectInfo` interface with `type` (singular string), `testFramework`, `hasTypeScript`, `packageManager`, `monorepo`. The file written to disk does not conform to its own schema.

**Recommendation**: Update the schema to match the implementation's flat structure, since the simpler format works well for agent injection.

### Gap 2: Incomplete Schema Version Tracking in `project-info.json`

The `schemas` block tracks versions for `todo`, `config`, `archive`, and `log` but does NOT track `project-info.json` itself or `project-context.json`.

**Recommendation**: Add `projectInfo` and `projectContext` entries to the `schemas` tracking block.

### Gap 3: No Staleness Validation for `project-info.json`

The `schemas` versions recorded in `project-info.json` could drift from the actual schema files in `.cleo/schemas/`. No validation currently detects this.

**Recommendation**: Add a `cleo doctor` check that compares `project-info.json` `schemas{}` versions against the actual schema files.

### Gap 4: Schema `$id` Inconsistency

`config.schema.json` uses a local `$id` (`claude-todo-config-schema-v2.1`) while `project-info.schema.json` and `project-context.schema.json` use URI-based `$id`s (`https://cleo-dev.com/schemas/v1/...`).

**Recommendation**: Normalize all schemas to URI-based `$id` format.

### Gap 5: Underutilized `project-context.json` Schema

The schema defines `testing` (command, patterns, directories), `conventions` (fileNaming, importStyle, typeSystem), `build` (command, outputDir), `directories` (source, tests, docs), and `llmHints` (commonPatterns, avoidPatterns) -- none of which are populated by `detectProjectType()`.

**Recommendation**: Enhance `detectProjectType()` to populate at minimum `llmHints`, `conventions`, and `testing.command`, since these directly serve the LLM agent use case.

### Gap 6: Missing `getProjectContextPath()` Utility

`src/core/paths.ts` provides `getConfigPath()`, `getTaskPath()`, `getSessionsPath()`, and `getProjectInfoPath()` but has no `getProjectContextPath()`. The path is constructed inline in `initProjectDetect()` and `upgrade.ts`.

**Recommendation**: Add a canonical path function to `src/core/paths.ts`.

## 10. ADR-006 Amendment

This ADR amends ADR-006 Section 1. The current text reads:

> JSON is EXCLUSIVELY RESERVED for human-editable, git-tracked configuration files (`config.json`, `project-info.json`).

This is amended to:

> JSON is EXCLUSIVELY RESERVED for human-editable, git-tracked configuration files (`config.json`, `project-info.json`, `project-context.json`).

The `Amended By` header in ADR-006 is updated to include ADR-011.

## 11. Consequences

### Positive

- Single canonical reference document for the entire config file ecosystem
- ADR-006 JSON exemption list is now complete and accurate
- Identified gaps enable targeted improvement work with clear scope
- Injection chain for `project-context.json` is formally documented

### Tradeoffs

- Schema/implementation mismatch (Gap 1) is documented but not resolved by this ADR
- No immediate implementation changes -- this ADR describes the architecture as-is plus recommendations
- The six gaps represent future work that should be prioritized based on impact

## 12. References

- `.cleo/adrs/ADR-006-canonical-sqlite-storage.md` -- Storage architecture (amended by this ADR)
- `.cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md` -- Shared-core architecture
- `src/core/config.ts` -- Configuration resolution cascade (defaults, env map, load/get/set)
- `src/core/init.ts` -- File creation logic (`initCoreFiles`, `initProjectInfo`, `initProjectDetect`)
- `src/core/upgrade.ts` -- Staleness refresh logic for `project-context.json`
- `src/store/project-detect.ts` -- `detectProjectType()` and `ProjectInfo` interface
- `src/store/project-registry.ts` -- Hybrid registry (`getProjectInfo`, `saveProjectInfo`, `getProjectData`)
- `src/core/system/health.ts` -- Health checks interacting with `project-info.json`
- `src/core/paths.ts` -- Path utilities (`getConfigPath`, `getGlobalConfigPath`, `getProjectInfoPath`)
- `.cleo/schemas/config.schema.json` -- Config schema (v2.10.0)
- `.cleo/schemas/project-info.schema.json` -- Project info schema (v1.0.0)
- `.cleo/schemas/project-context.schema.json` -- Project context schema (v1.0.0)
- `~/.cleo/templates/AGENT-INJECTION.md` -- Injection template containing `@.cleo/project-context.json`
