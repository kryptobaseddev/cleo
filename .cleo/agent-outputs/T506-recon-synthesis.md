# T506 Recon Synthesis — Dependency Packaging & Code Intelligence Unification

## Executive Summary

5 explorer agents mapped the full landscape. CLEO has a critical packaging gap: `npm install -g @cleocode/cleo` leaves users with silently broken features (tree-sitter code analysis), no dependency verification, and 11 overlapping health check systems. GitNexus (at /mnt/projects/gitnexus) solves the tree-sitter problem by using native Node bindings instead of CLI subprocess.

## Dependency Wave Order

```
Wave 0: T507 (Dependency Registry SSoT) — FOUNDATION, no deps
Wave 1: T508 (Postinstall) + T509 (tree-sitter migration) + T511 (Health consolidation) — parallel, blocked by T507
Wave 2: T510 (@cleocode/nexus package) — blocked by T509
Wave 3: T512 (GitNexus absorption) — blocked by T510
```

## Key Files Per Stream

### T507 — Dependency Registry
- CREATE: `packages/contracts/src/dependency.ts` (interfaces)
- CREATE: `packages/core/src/system/dependencies.ts` (SSoT registry)
- MODIFY: `packages/core/src/system/health.ts` (wire dependency checks into doctor)

### T508 — Postinstall Enhancement
- MODIFY: `packages/cleo/bin/postinstall.js` (add dep verification after bootstrap)
- MODIFY: `packages/core/src/bootstrap.ts` (add verifyBootstrapComplete)

### T509 — tree-sitter Migration
- MODIFY: `packages/core/package.json` (optionalDeps → deps, add tree-sitter native)
- REWRITE: `packages/core/src/code/parser.ts` (native bindings, not CLI subprocess)
- MODIFY: `packages/core/src/lib/tree-sitter-languages.ts` (adapt for native loader)
- REFERENCE: `/mnt/projects/gitnexus/gitnexus/src/core/tree-sitter/parser-loader.ts`

### T510 — @cleocode/nexus Package
- CREATE: `packages/nexus/` (full package scaffold)
- MOVE: `packages/core/src/nexus/` → `packages/nexus/src/registry/`
- MOVE: `packages/core/src/code/` → `packages/nexus/src/code/`
- CREATE: `packages/nexus/src/schema/code-index.ts` (Drizzle schema)
- MODIFY: `packages/core/src/internal.ts` (re-export from nexus for backward compat)

### T511 — Health Consolidation
- MODIFY: `packages/core/src/system/health.ts` (integrate deps, dedup checks)
- MODIFY: `packages/cleo/src/cli/commands/self-update.ts` (use shared preflight)
- MODIFY: `packages/cleo/src/cli/commands/upgrade.ts` (use shared preflight)
- MODIFY: `packages/cleo/src/dispatch/engines/system-engine.ts` (wire adapter health)

### T512 — GitNexus Absorption
- CREATE: `packages/nexus/src/intelligence/` (language providers, graph model)
- CREATE: `packages/contracts/src/graph.ts` (node types, relationship types)
- REFERENCE: `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/language-provider.ts`
- REFERENCE: `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/type-extractors/`
- REFERENCE: `/mnt/projects/gitnexus/gitnexus-shared/src/graph/types.ts`

## GitNexus Key Patterns to Port

1. **tree-sitter@0.21.1** as native Node binding (not CLI subprocess)
2. **LanguageProvider** strategy pattern with per-language extractors
3. **Graph node types**: Function, Class, Interface, Method, Property, etc.
4. **Relationship types**: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, ACCESSES, etc.
5. **Confidence scoring** on relationships (1.0 certain → 0.7 fuzzy)
6. **Impact analysis**: BFS with depth-based risk grouping
7. **Single global Parser instance** with lazy language loading

## What NOT to Port from GitNexus

- LadybugDB (use Drizzle/SQLite instead)
- Web UI / visualization
- MCP server (CLEO has its own dispatch layer)
- Embeddings / semantic search (future enhancement)
- Community detection / Leiden algorithm (future)
- Process/execution flow detection (future)

## Current State Summary

| System | Files | Lines | Tests |
|--------|-------|-------|-------|
| NEXUS (core/nexus/) | 11 | ~2000 | 7 test files |
| Code Analysis (core/code/) | 5 | ~800 | unknown |
| Health (core/system/health.ts) | 1 | 1313 | via doctor tests |
| Postinstall (cleo/bin/) | 1 | 93 | none |
| Bootstrap (core/bootstrap.ts) | 1 | 440 | none |
| Doctor CLI | 1 | 181 | none |
| CAAMP Doctor | 1 | 644 | unknown |
