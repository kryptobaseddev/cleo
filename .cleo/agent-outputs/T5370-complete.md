# T5370 Complete: JSON Cleanup + Validation (v2)

## src/store/project-registry.ts Investigation

**Status**: Legacy JSON store, still contains active read/write functions for `projects-registry.json`.

**Key findings**:
- The file is a legacy JSON-based project registry (`~/.cleo/projects-registry.json`)
- It was ported from `lib/data/project-registry.sh` as part of T4552
- It contains full CRUD operations: read, write, prune, remove, list
- **Callers**: Only imported by `src/store/__tests__/project-registry.test.ts` (for `generateProjectHash`)
- **No active callers** use its JSON read/write functions from production code
- `src/core/nexus/registry.ts` is the active replacement using nexus.db (SQLite via Drizzle)
- `src/core/nexus/migrate-json-to-sqlite.ts` handles migration from the JSON file to nexus.db
- `generateProjectHash()` in this file delegates to `src/core/nexus/hash.ts` (canonical)

**Conclusion**: This file is effectively dead code. The nexus registry (SQLite) has fully replaced it. The only function still potentially useful (`generateProjectHash`) is a thin wrapper around the canonical `src/core/nexus/hash.ts`. This file should be marked `@deprecated` in a future cleanup task.

## Proof 1: No Active JSON Write Paths

```
$ grep -rn "writeFile.*projects-registry|writeFileSync.*projects-registry" src/ --include="*.ts"
(no output — 0 lines)
```

## Proof 2: projects-registry.json References

```
src/store/project-registry.ts:6:   * - Global registry (~/.cleo/projects-registry.json): Minimal info, system-wide
src/store/project-registry.ts:69:  return join(getCleoHome(), 'projects-registry.json');
src/cli/commands/__tests__/nexus.test.ts:68:  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
src/core/nexus/migrate-json-to-sqlite.ts:2: * Migrate legacy projects-registry.json to nexus.db (SQLite).
src/core/nexus/migrate-json-to-sqlite.ts:23: * For each project entry in projects-registry.json:
src/core/nexus/__tests__/registry.test.ts:63:  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
src/core/nexus/__tests__/permissions.test.ts:47:  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
src/core/nexus/registry.ts:7: * Legacy JSON backend (projects-registry.json) is migrated on first init
src/core/nexus/registry.ts:78:  return process.env['NEXUS_REGISTRY_FILE'] ?? join(getCleoHome(), 'projects-registry.json');
src/core/nexus/__tests__/reconcile.test.ts:68:  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
src/core/nexus/__tests__/deps.test.ts:96:  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
src/core/nexus/__tests__/query.test.ts:63:  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
```

All references are in expected locations: test files (env var for isolation), migration utility, registry.ts (legacy path getter), and the legacy store module itself.

## Proof 3: nexus.db Status

```
-rw-r--r--. 1 keatonhoskins keatonhoskins 73728 Mar  4 23:37 /home/keatonhoskins/.cleo/nexus.db
```

nexus.db exists and is active (73KB).

## Proof 4: JSON Migrated File

```
-rw-r--r--. 1 keatonhoskins keatonhoskins 41772 Mar  4 23:17 /home/keatonhoskins/.cleo/projects-registry.json
```

Legacy JSON file still exists (kept as migration source / historical reference).

## TODO Scan Results

Scanned all nexus-related files:
- `src/core/nexus/` (all .ts files)
- `src/store/nexus-schema.ts`
- `src/store/nexus-sqlite.ts`
- `src/store/project-registry.ts`
- `src/dispatch/domains/nexus.ts`
- `src/cli/commands/nexus.ts`

**Result: 0 TODOs, 0 FIXMEs, 0 HACKs, 0 XXXs found.**

## _-prefix Import Scan Results

Scanned `src/core/nexus/`, `src/store/nexus-schema.ts`, `src/store/nexus-sqlite.ts`, `src/dispatch/domains/nexus.ts`.

**Findings**:
- `src/core/nexus/query.ts`: `_project` field on `NexusResolvedTask` type — active data field (task enriched with project name). **Not unused.**
- `src/store/nexus-sqlite.ts`: `_nexusDb`, `_nexusNativeDb`, `_nexusDbPath`, `_nexusInitPromise` — module-level singleton variables for lazy DB init. **Not unused.**
- `src/dispatch/domains/nexus.ts`: `_meta` and `_project` — dispatch metadata and active data fields. **Not unused.**

## nexus-registry.schema.json Deprecation

**Already deprecated.** The description field reads:
> "DEPRECATED: This schema is no longer used. nexus.db (SQLite) is the live backend as of 2026.3. Legacy JSON (projects-registry.json) is auto-migrated on first nexus init. Retained for historical reference only."

No action needed.

## Additional Fix: warp-chain.ts Unused Import

Fixed pre-existing TSC error: removed unused `import type { Stage }` from `src/types/warp-chain.ts` (line 11).

## Test Results

- **tsc --noEmit**: 0 nexus-related errors. Pre-existing warnings in `brain-accessor.ts` (Phase 3 PageIndex prep imports) and `brain-reasoning.ts` (unused Task type) — not nexus-related.
- **vitest src/core/nexus/**: 5 files, 80 tests, ALL PASSING
- **vitest full suite**: 246 files, 3955 tests — 3951 passing, 4 failing
  - **Failures**: All in `src/mcp/gateways/__tests__/mutate.integration.test.ts` (session focus tests) — PRE-EXISTING, not caused by nexus changes.

## Status: COMPLETE
