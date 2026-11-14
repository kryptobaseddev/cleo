# ADR-031: Provider Adapter Architecture

**Status**: Accepted
**Date**: 2026-03-16
**Task**: T5240
**Epic**: T5240

---

## Context

CLEO's brain observation capture, context injection, and plugin system were built as Claude Code-specific implementations. The `.claude-plugin/` directory contained bash scripts and a Node.js daemon that only worked with Claude Code's hook system. This violated CLEO's constitutional vision of vendor-neutral portability.

Specific problems:
1. **Provider lock-in**: Brain hooks, spawn adapters, and installation were hardcoded to Claude Code
2. **No shared interface**: Adding a new provider (OpenCode, Cursor) required duplicating adapter code in `src/core/` with no shared contract
3. **Spawn adapters scattered**: `src/core/spawn/adapters/claude-code-adapter.ts` and `opencode-adapter.ts` had no common interface beyond `CLEOSpawnAdapter`
4. **Installation coupling**: `src/core/install/claude-plugin.ts` was the only installation path

---

## Decision

Introduce a **Provider Adapter System** with three layers:

### 1. Contracts Package (`packages/contracts/`)

A schema-only npm workspace package (`@cleocode/contracts`) defining:
- `CLEOProviderAdapter` — the primary adapter interface with lifecycle methods (`initialize`, `dispose`, `healthCheck`)
- `AdapterHookProvider` — maps provider-specific events to CAAMP canonical events
- `AdapterSpawnProvider` — wraps provider-specific spawn mechanisms
- `AdapterInstallProvider` — handles provider registration, MCP config, and instruction file references
- `AdapterCapabilities` — declares what each adapter supports (hooks, spawn, MCP, instruction files)
- `AdapterManifest` — discovery metadata with detection patterns

### 2. Adapter Packages (`packages/adapters/{provider}/`)

One package per provider, each exporting a `CLEOProviderAdapter` implementation:
- **claude-code**: Full adapter with hooks (8 CAAMP events), spawn (via `claude` CLI), install (CLAUDE.md, .mcp.json)
- **opencode**: Full adapter with hooks (6/8 events), spawn (via `opencode` CLI), install (AGENTS.md, .opencode/config.json)
- **cursor**: Install-only adapter with no hooks or spawn support. Writes `.cursor/rules/cleo.mdc` (MDC format) and registers MCP in `.cursor/mcp.json`

Each adapter has a `manifest.json` for discovery and detection patterns (env vars, file existence, CLI availability).

### 3. AdapterManager (`src/core/adapters/manager.ts`)

Central singleton that manages the adapter lifecycle:
1. **discover()** — scans `packages/adapters/` for `manifest.json` files
2. **detectActive()** — evaluates detection patterns against the current environment
3. **activate(id)** — dynamically imports and initializes the adapter
4. **getActive()** — returns the currently active adapter
5. **dispose()** — clean shutdown of all initialized adapters

### Shared Utilities (`packages/shared/`)

Runtime utilities shared across adapters:
- Observation formatter and tool skip logic
- CLEO CLI wrapper for adapter use
- Hook dispatch helpers

### Key Design Decisions

- **Adapters are entry-point connectors only** — they handle how providers connect to CLEO, not how CLEO works internally
- **Adapters NEVER write memory content** — CLEO core owns all memory operations via the Memory Bridge (ADR-032)
- **Dynamic import** — adapters are loaded at runtime, not bundled, so missing adapter packages are graceful no-ops
- **CAAMP integration** — detection uses CAAMP's provider registry for canonical provider identification

---

## Consequences

### Positive
- Adding a new provider requires only a new package in `packages/adapters/` with a `manifest.json`
- Each adapter is independently testable (71 tests across 3 adapters)
- No provider-specific code in `src/core/` — all adapter logic lives in packages
- The `.claude-plugin/` directory and its bash scripts are fully eliminated

### Negative
- npm workspaces add build complexity (mitigated by esbuild bundling)
- Dynamic imports mean adapter errors surface at runtime, not compile time
- Three separate packages to maintain instead of one directory

### Neutral
- The `SpawnAdapterRegistry` in `src/core/spawn/` now bridges to adapter packages via a `bridgeSpawnAdapter()` function rather than direct imports
- Sessions table gains a `providerId` column to track which adapter was active

---

## References

- ADR-032: Provider-Agnostic Memory Bridge
- `packages/contracts/src/adapter.ts` — CLEOProviderAdapter interface
- `src/core/adapters/manager.ts` — AdapterManager
- `packages/adapters/*/manifest.json` — adapter manifests
