# T551 — nexus-bridge.md Generator

**Status**: complete
**Task**: T549-NX: Create nexus-bridge.md — auto-generated code intelligence context for agents

## Summary

Created a `nexus-bridge.md` generator that auto-produces a project-level code intelligence
summary for agent consumption. This is the NEXUS equivalent of `memory-bridge.md`.

## Files Created / Modified

### Created
- `/mnt/projects/cleocode/packages/core/src/nexus/nexus-bridge.ts`
  - `generateNexusBridgeContent(projectId, repoPath)` — queries nexus.db, builds markdown
  - `writeNexusBridge(projectRoot, projectId?)` — writes `.cleo/nexus-bridge.md`, skips unchanged
  - `refreshNexusBridge(projectRoot, projectId?)` — best-effort never-throws wrapper

### Modified
- `/mnt/projects/cleocode/packages/core/src/internal.ts`
  - Exports `generateNexusBridgeContent`, `writeNexusBridge`, `refreshNexusBridge`

- `/mnt/projects/cleocode/packages/core/src/scaffold.ts`
  - Added `checkNexusBridge(projectRoot)` — doctor check (warning if missing)

- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/nexus.ts`
  - `cleo nexus analyze` now calls `refreshNexusBridge()` after pipeline flush (best-effort)
  - Added `cleo nexus refresh-bridge [path]` subcommand for manual regeneration

## nexus-bridge.md Content Shape

```markdown
# CLEO Nexus Bridge — Code Intelligence

> Auto-generated from nexus index. Regenerate with `cleo nexus analyze`.
> Project: /path/to/project

## Index Status
- **Files**: 1,768 indexed
- **Symbols**: 20,989 total (functions: 5,432, classs: 891, ...)
- **Relations**: 42,223 total (calls: 18,432, imports: 12,891, extends: 432)
- **Communities**: 12 functional clusters
- **Execution Flows**: 45 traced processes
- **Last Indexed**: 2026-04-13T04:00:00.000Z
- **Date**: 2026-04-13

## Top Entry Points
1. `main` — packages/cleo/src/cli/index.ts (42 callees)
...

## Functional Clusters
1. **Task Management** (234 symbols) — packages/core/src/tasks/
...

## Code Intelligence Commands
| Need | Command |
|------|---------|
| What calls this function? | `cleo nexus context <symbol>` |
...
```

## Design Decisions

1. **Native DatabaseSync queries** — uses the `getNexusNativeDb()` raw sqlite handle
   with manual SQL, matching how `memory-bridge.ts` uses `getBrainNativeDb()`. Avoids
   Drizzle ORM which uses synchronous `.all()` / `.run()` methods incompatible with async generators.

2. **Graceful empty state** — if nexus.db has no data for the project, writes a
   placeholder "not indexed" bridge with just the command reference.

3. **Idempotent writes** — skips writing if content matches existing file (ignores
   the date line to avoid trivial churn).

4. **Best-effort in analyze** — the `refreshNexusBridge` call in `nexus analyze` is
   wrapped in a try/catch so bridge failures never fail the index run.

5. **checkNexusBridge in scaffold.ts** — warning-level (not failure) since the file
   only exists after `cleo nexus analyze` has been run at least once.

## Quality Gates

- `pnpm biome check --write`: PASSED (3 files fixed)
- `pnpm run build`: PASSED
- `pnpm run test`: PASSED (396 files, 7129 tests, 0 new failures)
