# Changelog

All notable changes to CLEO are documented in this file.
CLEO uses [Calendar Versioning](https://calver.org/) with format `YYYY.MM.PATCH`.

---

## [2026.3.1] - 2026-03-01

### Bug Fixes

- **Prevent database wipe on branch switch (T5184)** — Removed `.cleo/tasks.db-wal` and `.cleo/tasks.db-shm` from git tracking. Git-tracked empty WAL/SHM blobs overwrote live SQLite WAL on branch switch, destroying pending writes. Added auto-recovery safety net that detects empty databases with valid backups and restores on startup. Added extended git-tracking warning on MCP server startup.

- **Relates add persistence bug (T5168)** — Fixed `addRelation()` in `src/core/tasks/relates.ts` to write to `task_relations` junction table via `accessor.addRelation()`. Previously, relates data was silently lost because `taskToRow()` has no `relates` column. Added 5 new Vitest tests for relates persistence.

- **Pre-commit hook blocks WAL/SHM removal (T5184)** — Fixed pre-commit hook to allow `git rm --cached` operations on WAL/SHM files using `--diff-filter=ACMR`.

---

## [2026.3.0] - 2026-03-01

### Major Changes

- **Engine Consolidation** — Relocated all engine adapters from `src/mcp/engine/` to `src/dispatch/engines/`, establishing `src/dispatch/` as the canonical dispatch layer. Deleted the entire `src/mcp/engine/` directory (13 files, ~5,000 lines). MCP barrel re-exports preserved for backward compatibility.

- **RCASD Provenance Consolidation (T5100)** — Full lifecycle provenance system with 6 phases, 17 agents. Migrated `rcsd/` to `rcasd/` naming, added lifecycle provenance columns to schema, created consolidation pipeline with evidence tracking and frontmatter parsing.

- **MVI Tier-Based Projection (T5096)** — Progressive disclosure system with minimal/standard/orchestrator tiers. Session-scope-aware tier resolution (epic scope auto-maps to orchestrator). Projection middleware strips fields by tier. Cost hints in admin help.

- **Tier-Based Protocol Injection (T5155)** — Subagent spawns now receive tier-filtered protocol content. Injection chain doctor checks validate tier marker integrity.

### Features

- Agent-safe dependency enforcement across 5 enforcement points (T5069)
- Transitive dependency hints in task query responses (T5069)
- `ensureArray()` for MCP array parameter normalization (T5094)
- Core log reader library for observability with pino JSONL parsing (T5187)
- Find filters, list compact projection, and help cost hints (T5073, T5072)
- Task relations batch loading and `relates` field (T5168)
- Injection chain doctor checks (T5153)
- Decision trees and anti-patterns added to ct-cleo skill (T5154)
- Atomic task ID allocation with collision detection (T5184)

### Bug Fixes

- SQLite WAL mode verification and `BEGIN IMMEDIATE` for migrations (T5173)
- Retry+backoff for `SQLITE_BUSY` during migrations (T5185)
- TOCTOU race in task ID generation fixed with atomic allocation (T5184)
- 4 dispatch-layer bugs resolved (T5148, T5149, T5157, T5168)
- `addRelation` passthrough added to SafetyDataAccessor (T5168)
- Stale imports in brain-operations test (T5107, T5108)
- `taskComplete` wired through core with MCP bootstrap hints (T5069, T5090)
- MVI tier projection and spawn tier filtering (T5096, T5155)

### Refactoring

- Consolidated task, release, validate, config, and init engines into dispatch layer (T5100, T5109-T5111)
- Unified `EngineResult` type to single canonical definition (T5093)
- Fixed layer violations by relocating shared utilities out of `mcp/engine` (T5095)
- Removed vestigial `AGENT-INJECTION.md` files (T5152)
- Restructured `CLEO-INJECTION.md` to minimal-only v2.1.0 template (T5100)
- Removed 236 unused schemas and archived legacy schemas (T5100)
- Deleted `dev/recover-tasks.ts` and its guardrail test
- Removed legacy experiment scripts and duplicate specification docs

### Documentation

- Comprehensive documentation audit and Git Flow branching setup (T4556)
- Architecture references updated for dispatch-first engine layout (T5098)
- Workspace research added to RCASD provenance (T5164)
- RCASD lifecycle manifests, kept schemas, and task fields guide (T5164)
- Sibling limit docs aligned (T4862)

### Tests

- E2E tests for injection chain and tier filtering (T5156)
- Post-consolidation architectural verification parity tests (T5099)
- Dispatch-layer parity integration tests
- Task relations persistence tests (T5168)
- Spawn tier filtering tests
- Projection middleware tests
- Doctor injection chain checks tests (T5153)

---

## [2026.2.9] - 2026-02-28

### Bug Fixes

- **Fixed critical npm install failure — drizzle-orm/zod ERR_PACKAGE_PATH_NOT_EXPORTED** — The npm-published package was completely broken on install. The `drizzle-orm` dependency used `^1.0.0-beta.15` which npm resolved to `1.0.0-beta.9-e89174b` due to semver pre-release alphanumeric sorting ranking hash-suffixed versions higher than numeric identifiers (`9-e89174b` > `15`). This version lacks the `./zod` export, causing all CLI and MCP operations to crash immediately. Fixed by pinning to exact version `1.0.0-beta.15-859cf75`. Both `drizzle-orm` and `drizzle-kit` are now pinned.

- **Added `cleo mcp` subcommand for MCP server launch** — All AI agent configs use `npx -y @cleocode/cleo@latest mcp`, but `mcp` was not a CLI subcommand (the binary is `cleo-mcp`). Added `mcp` as a pre-parse argv check that spawns `dist/mcp/index.js` with inherited stdio, enabling all agents to launch the MCP server via the standard `cleo mcp` invocation. The `--mcp-server` flag is preserved for backward compatibility.

---

## [2026.2.7] - 2026-02-28

### Bug Fixes

- **Fixed audit_log missing dispatch columns migration (T5063)** — The `audit_log` table schema defined 17 columns including 9 dispatch layer columns, but the migration chain only created 8. A migration referenced as `20260225200000` was never committed. This caused `core-parity.test.ts` `taskCreate` test to fail consistently on fresh databases because drizzle generates INSERT SQL for all 17 schema columns. Fixed with a custom drizzle-kit migration using table rebuild pattern for idempotency. Test suite: 2779/2780 → 2884/2884 (100%).

---

## [2026.2.6] - 2026-02-27

### Major Features

- **Installation Channels & Dev Runtime Isolation (ADR-016)** — Three distinct runtime channels:
  - **Stable**: `cleo`, `cleo-mcp`, optional `ct` alias (`@cleocode/cleo@latest`)
  - **Beta**: `cleo-beta`, `cleo-mcp-beta`, optional `ct-beta` (`@cleocode/cleo@beta`)
  - **Dev**: `cleo-dev`, `cleo-mcp-dev` with isolated `~/.cleo-dev` data root (no `ct`)
  - Channel-aware installer manages command naming and data isolation
  - Runtime diagnostics expose channel identity via `cleo env info` and `admin.runtime`

- **BRAIN Memory Integration** — Initial BRAIN Network domain with pattern and learning memory:
  - `memory.pattern.search` / `memory.pattern.stats` — Pattern memory operations
  - `memory.learning.search` / `memory.learning.stats` — Learning memory operations

- **Session Architecture Overhaul (T4959, T5039-T5042)** — Complete session system rewrite:
  - Drizzle-first session types with `SessionView` abstraction
  - Session identity architecture with proper agent session transitions
  - Removed `multiSessionEnabled` flag, `sessionHistory` array, and all `@deprecated` annotations
  - Deleted legacy MCP `session-engine.ts` — zero legacy session code remaining
  - Fixed handoff/briefing pipeline for LLM agent session transitions

- **CQRS Dispatch Architecture (T4814-T4816)** — New dispatch layer:
  - Domain handler registry with middleware pipeline (audit, validation, routing)
  - Push policy for release operations with documentation and branding
  - LAFS alignment with domain architecture cleanup

### Architecture

- **Shared-Core Pattern Verified** — CLI and MCP both delegate to `src/core/` (T4565/T4566 audit)
- **node:sqlite Migration** — Replaced sql.js with Node.js native SQLite in migration, atomic, and checksum modules (T4949, T4950)
- **JSON Storage Engine Removed** — SQLite-only storage, no more dual-engine path (T4854)
- **ADR System Canonicalization** — Full ADR lifecycle with cognitive search, RCASD auto-linking, task traceability, frontmatter validation (T4792, T4942)
- **Lifecycle Standardization** — RCASD-IVTR+C canonical naming with backward compatibility shims (T4798)
- **Pino + SQLite Dual-Write Logging** — Replaced JSON file audit logger (T4844)
- **Drizzle ORM v1.0.0-beta.15** — Upgraded with fixed save flow and FK orphan handling (T4817, T5034)
- **8-Wave Reconciliation** — Lifecycle, domains, RCASD, naming, BRAIN, audit, and V2 port consolidation

### Features

- Universal `--field/--fields/--mvi` flags on all CLI commands (T4953)
- `--field` + `--human` uses `renderGeneric` for extracted data display (T4541)
- Focus system migrated to canonical `start/stop/current` verbs (T4911)
- CAAMP skill catalog alignment for bundled operations (T4680, T4820)
- Self-update with post-update bundled skill refresh
- `parentId` parameter accepted in `tasks.add` and `tasks.update` MCP operations (T5031, T5032)
- Fine-grained single-task writes in store layer (T5034)
- Pre-commit hook enforcing drizzle snapshot presence and SQLite WAL exclusion (T4792, T4894)
- Node.js v24+ minimum enforced with auto-install via fnm (T015)
- `cleo init` now auto-installs git hooks (`commit-msg`, `pre-commit`) from `templates/git-hooks/` (T5056)
- `grade.schema.json` moved to canonical `schemas/` directory; dead legacy schemas removed (T5056)

### Bug Fixes

- Fixed raw SQL graph queries returning arrays instead of objects (T4754)
- Fixed lifecycle `stageName` enum type casting (T4951)
- Fixed missing `await` on drizzle-proxy queries in task-store and session-store (T4754)
- Fixed `installSkill` missing await in skills install command (T4948)
- Fixed `.sequence.json` check graceful on missing file (T4836)
- Fixed drizzle migration callback wrapped in SQLite transaction
- Fixed `makeCleoGitEnv` relative-path bug for CLI checkpoint command (T4867)
- Fixed git commit restricted to staged `.cleo/` state file paths only (T4871)
- Fixed orphaned `parentId` references with FK cascade and `ON DELETE SET NULL` (T5034)
- Fixed README.md corrupted alignment tag from sed artifact
- Removed two hand-written drizzle migrations missing `snapshot.json` (orphaned SQL not in schema)

### Refactoring

- Removed all `@deprecated` annotations and dead aliases (T5041)
- Eliminated duplicate operations across MCP domains (T4773)
- Removed leaked operations from admin domain (T4774, T4775)
- Removed dispatch/lib bridge imports from mcp/lib (T4832)
- Centralized `--field/--fields/--human` in `cliOutput` for all commands (T4953)
- Extracted system, orchestrate, validate, task-noncrud, lifecycle, research, config, init, release engine logic to `src/core/` (T4782-T4790)
- Fixed 5 verb standard violations (T4792)
- Consolidated CLAUDE.md into AGENTS.md as single canonical instruction file (T4546)
- Complete data integrity tools and migration system consolidation (ADR-006, T4699)

### Documentation

- **ADR-016**: Installation channels and dev runtime isolation
- **CLEO-INSTALL-CHANNELS-SPEC.md**: Complete channel contract specification
- **CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md**: Provider MCP installation requirements
- **ADR-009**: BRAIN cognitive architecture
- **ADR-011**: Project configuration architecture
- **Verb Standards v2**: 17 missing verbs added, LAFS output format flags documented (T4732)
- CalVer versioning scheme documented in CONTRIBUTING.md
- Updated CONTRIBUTING.md with TypeScript conventions and dev channel setup
- Updated README version badge and fixed corrupted HTML tag
- Comprehensive `.gitignore` update for runtime data, IDE configs, and secret exclusion

### Developer Experience

- Runtime channel detection via `cleo env info --json`
- Warnings when dev channel invoked via `cleo` instead of `cleo-dev`
- Isolated dev data root prevents collisions with stable installs
- CAAMP integration for provider-specific MCP configuration
- Pre-commit hooks for drizzle snapshot enforcement and SQLite WAL exclusion

---

## [2026.2.5] - 2026-02-25

### Changes

- Infrastructure consolidation: agent-outputs, gitignore, init, upgrade (T001)

---

## [2026.2.4] - 2026-02-24

### Features

- Add pre-flight migration check to core — detect JSON data needing SQLite migration (T4699)

---

## [2026.2.3] - 2026-02-23

### Features

- Add pre-flight migration check to core — detect JSON data needing SQLite migration (T4699)

---

## [2026.2.1] - 2026-02-17

### Features

- **SQLite storage activated** — All task domain data stored in SQLite via DataAccessor abstraction (ADR-002)
- LAFS type conformance in gateway-meta.ts
- release-engine.ts migrated to async DataAccessor pattern

### Bug Fixes

- Fixed T4454 master epic type from "task" to "epic"
- Cleared stale focus pointer to archived task T4654
- Resolved T4653 orphan (parent T4638 in archive)
- Fixed release-engine loadTasks() to use DataAccessor with JSON fallback for tests
- Fixed release domain handler mutateNative() to properly await async engine functions

### Architecture

- DataAccessor pattern fully wired: StoreProvider, all MCP engines, all core modules
- Storage migration verified: 278 tasks + 3,978 archived + 606 sessions
- 2,419 tests pass, 0 failures (125 test files)
