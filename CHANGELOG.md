# 2026.2.6

### Major Features

- **Installation Channels & Dev Runtime Isolation** — CLEO now supports three distinct runtime channels:
  - **Stable**: Production use with commands `cleo`, `cleo-mcp`, and optional `ct` alias
  - **Beta**: Prerelease validation with `cleo-beta`, `cleo-mcp-beta`, and optional `ct-beta`
  - **Dev**: Contributor-isolated runtime with `cleo-dev`, `cleo-mcp-dev` (no `ct`)
  - Dev channel uses isolated data directory (`~/.cleo-dev`) for parallel-safe development
  - Channel-aware installer in `installer/lib/link.sh` manages command naming
  - Runtime diagnostics expose channel identity via `cleo env info` and `admin.runtime` query

- **BRAIN Memory Integration** — Initial BRAIN Network domain with pattern and learning memory operations:
  - `memory.pattern.search` — Search pattern memory by type, impact, or keyword
  - `memory.pattern.stats` — Pattern memory statistics
  - `memory.learning.search` — Search learning memory by confidence, actionability
  - `memory.learning.stats` — Learning memory statistics by confidence band

### Architecture

- **TypeScript Migration Complete** — Full migration from Bash to TypeScript/Node.js
  - All core business logic in `src/core/` following MCP-First + Shared Core architecture
  - CLI and MCP are thin wrappers around canonical core modules
  - node:sqlite replaces sql.js for database operations
  - 2,419 tests passing via Vitest (BATS legacy coverage maintained)

- **ADR System Canonicalization** — Architectural Decision Records now fully integrated:
  - ADR cognitive search capabilities
  - RCASD auto-linking with task traceability
  - ADR-016: Installation Channels specification
  - Frontmatter validation and compliance checking

- **Lifecycle System Standardization** — RCASD-IVTR+C naming and compatibility:
  - Research → Consensus → Architecture Decision → Specification → Decomposition → Implementation → Validation → Release → Contribution
  - Standardized naming across all lifecycle stages
  - Backward compatibility shims for legacy naming

### Features

- Universal `--field/--fields/--mvi` flags on all CLI commands (T4953)
- Pino + SQLite dual-write logging for audit trails (T4844)
- Focus system migrated to canonical `start/stop/current` verbs (T4911)
- CAAMP skill catalog alignment for bundled operations (T4680, T4820)
- Self-update with post-update bundled skill refresh

### Bug Fixes

- Fixed registry operation count validation (78 query, 65 mutate)
- Fixed raw SQL graph queries returning arrays instead of objects
- Fixed lifecycle stageName enum type casting
- Fixed missing awaits on drizzle-proxy queries
- SQLite WAL file handling improvements to prevent corruption

### Documentation

- **CLEO-INSTALL-CHANNELS-SPEC.md** — Complete channel contract specification
- **CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md** — Provider MCP installation requirements
- **ADR-016** — Installation channels and dev runtime isolation architecture decision
- Updated README with channel-aware installation instructions
- Updated CONTRIBUTING.md with TypeScript conventions and dev setup
- **Important**: Raw `npm link` caveat documented — contributors must use `./install.sh --dev` for strict isolation

### Developer Experience

- Runtime channel detection via `cleo env info --json`
- Warnings when dev channel invoked via `cleo` instead of `cleo-dev`
- Isolated dev data root prevents collisions with stable installs
- CAAMP integration for provider-specific MCP configuration

---

# 2026.2.5

### Other Changes

- Infrastructure consolidation: agent-outputs, gitignore, init, upgrade (T001)


# 2026.2.4

### Features

- Add pre-flight migration check to core - detect JSON data needing SQLite migration (T4699)


# 2026.2.3

### Features

- Add pre-flight migration check to core - detect JSON data needing SQLite migration (T4699)


# Changelog

All notable changes to the CLEO system will be documented in this file.

## [Unreleased]

### Architecture
- Align skill catalog bootstrap with CAAMP at CLI and MCP startup using bundled `packages/ct-skills`
- Remove legacy ct-skills fallback resolution and local `installed-skills.json` version tracking paths
- Rewire orchestration and dispatch skill/provider operations to CAAMP-backed canonical APIs

### Features
- Add CAAMP-backed dispatch coverage for `tools.skill.*` and `tools.provider.*` operations
- Add post-update bundled skill freshness refresh in `self-update --post-update`

## [2026.2.1] - 2026-02-17

### Features
- **SQLite storage activated** — All task domain data (tasks, archive, sessions) now stored in SQLite via DataAccessor abstraction (ADR-002)
- LAFS type conformance in gateway-meta.ts — GatewayMetaRecord now extends canonical GatewayMeta from @cleocode/lafs-protocol v1.1
- release-engine.ts migrated to async DataAccessor pattern for todo.json access

### Bug Fixes
- Fixed T4454 master epic type from "task" to "epic"
- Cleared stale focus pointer to archived task T4654
- Resolved T4653 orphan (parent T4638 in archive)
- Fixed release-engine loadTasks() to use DataAccessor with JSON fallback for tests
- Fixed release domain handler mutateNative() to properly await async engine functions

### Architecture
- DataAccessor pattern fully wired: StoreProvider, all MCP engines, all core modules
- logOperation() accepts optional DataAccessor parameter — 7 bypassed log writes fixed
- Core guards, changelog, version-check, research modules accept accessor parameter
- release-engine.ts: releasePrepare, releaseChangelog, releaseGatesRun converted to async
- Full I/O audit completed: 27 core functions migrated, ~14 correctly direct JSON calls confirmed
- Storage migration: `cleo migrate-storage --to-sqlite --verify` verified 278 tasks + 3,978 archived + 606 sessions
- 2,419 tests pass, 0 failures (125 test files)
