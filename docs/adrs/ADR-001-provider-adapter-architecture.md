# ADR-001: Provider Adapter Architecture

**Status**: Accepted
**Date**: 2026-03-16
**Task**: T5240 (Provider-Agnostic Task Sync Adapter)

## Context

CLEO's provider interactions (hooks, spawn, install) were hardcoded to a single provider:

- `.claude-plugin/` directory contained bash scripts tightly coupled to Claude Code
- Direct spawn adapter implementations lived in `src/core/spawn/adapters/`, each requiring core code changes for new providers
- Provider-specific install logic in `src/core/install/claude-plugin.ts` assumed Claude Code as the only target
- The brain observation hooks system (`brain-worker.cjs`, `brain-hook.sh`) was wired exclusively to Claude Code's plugin format

This violated CLEO's constitutional vision of vendor-neutral portability. Supporting a new provider (e.g., OpenCode, Cursor) required modifying core business logic rather than simply adding an adapter.

## Decision

Implement a provider adapter system organized as npm workspace packages:

1. **`packages/contracts/`** (`@cleocode/contracts`) -- Type-only interfaces defining the adapter contract. Contains `CLEOProviderAdapter`, `AdapterCapabilities`, `AdapterHookProvider`, `AdapterSpawnProvider`, and `AdapterInstallProvider`. Zero runtime dependencies.

2. **`packages/shared/`** (`@cleocode/shared`) -- Runtime utilities shared across adapter implementations. Includes observation formatting, CLI wrapper for invoking CLEO commands, and hook dispatch coordination. Adapters depend on this; core does not.

3. **`packages/adapters/*/`** -- One package per provider, each containing:
   - `manifest.json` declaring provider ID, capabilities, and detection patterns
   - Implementation of `CLEOProviderAdapter` with provider-specific hook, spawn, and install logic
   - Independent test suite

4. **`src/core/adapters/`** (`AdapterManager`) -- Central lifecycle management with auto-discovery. Scans `packages/adapters/*/manifest.json` at startup, detects the active provider using CAAMP infrastructure, and manages adapter initialization and disposal.

Adapters are **entry-point connectors only**. They handle how providers connect to CLEO (hooks, spawning subagents, installing configuration), not how CLEO works internally. All business logic remains in `src/core/`.

### Discovery Model

AdapterManager uses a two-phase discovery process:

1. **Manifest scan**: Reads `manifest.json` from each adapter package directory to build a capability registry
2. **Provider detection**: Evaluates each manifest's `detectionPatterns` (environment variables, file presence, CLI availability) to identify the active provider

### Adapter Contracts

Each adapter MAY implement up to four sub-contracts:

| Contract | Purpose | Required |
|----------|---------|----------|
| `AdapterInstallProvider` | Write provider instruction files, register CLEO | Yes |
| `AdapterHookProvider` | Lifecycle hooks (session start/end, tool use) | No |
| `AdapterSpawnProvider` | Launch subagent processes | No |
| `CLEOProviderAdapter` | Top-level container for all sub-contracts | Yes |

Minimal adapters (e.g., Cursor) implement only `install`. Full-featured adapters (e.g., Claude Code) implement all four.

## Consequences

**Positive:**
- Adding a new provider requires only a new adapter package with no core code changes
- Each adapter is independently testable, versioned, and maintainable
- Provider detection reuses existing CAAMP infrastructure
- Clean separation between provider-specific and CLEO-core logic
- The contracts package has zero runtime dependencies, enabling external adapter development

**Negative:**
- npm workspaces add build configuration complexity
- Each adapter package needs its own `tsconfig.json` and build setup
- More files to maintain, though each is smaller and single-purpose
- Discovery requires a convention-based directory structure (`packages/adapters/*/manifest.json`)
