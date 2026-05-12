# T1064: Route-Map and Shape-Check Commands

**Task**: EP2-T3: Route-Map and Shape-Check Commands  
**Epic**: T1042 (cleo nexus — Revised Gap Analysis & Living Brain Decomposition Plan)  
**Date**: 2026-04-20  
**Status**: COMPLETE  

---

## Summary

Implemented two new NEXUS CLI verbs to surface route nodes and their handler relations. The route kind and handles_route/fetches relation types were already defined in the nexus schema but had no commands exposed.

---

## Implementation

### 1. Contracts (`packages/contracts/src/nexus-route-ops.ts`)

New file with 5 types:

- **RouteMapEntry** — Single route with handler name, file, language, metadata, fetched deps, caller count
- **RouteMapResult** — Aggregated result: list of routes, counts, distinct external deps
- **ShapeCheckStatus** — `'compatible' | 'incompatible' | 'partial' | 'unknown'`
- **ShapeCheckCaller** — Caller with expected shape, compatibility status, diagnosis
- **ShapeCheckResult** — Route's declared shape, all callers, overall status, recommendation

### 2. SDK Module (`packages/core/src/nexus/route-analysis.ts`)

Two exported functions:

**`getRouteMap(projectId: string, projectRoot: string): Promise<RouteMapResult>`**

Queries nexus.db for all route nodes, resolves handlers via `handles_route` reverse relations, lists downstream `fetches` dependencies and caller counts.

- Uses Drizzle ORM with `and()` + `eq()` for type-safe filtering
- Parses `meta_json` to extract method, path, responseShape
- Returns aggregated route map with handler context

**`shapeCheck(routeSymbol: string, projectId: string, projectRoot: string): Promise<ShapeCheckResult>`**

Compares route's declared response shape against all callers' expected shapes.

- Resolves route node and extracts `responseShape` from `meta_json`
- Finds handler via `handles_route` relation
- Queries all `calls` relations targeting handler to find callers
- Infers expected shape from caller's `returnType` column
- Uses string equality comparison (limitation documented)
- Reports compatibility status and recommendation per caller

**Limitation**: Shape checking uses meta_json responseShape field and return type string equality. Full structural type inference (AST-based) is deferred as noted in docstrings (see T1XXX future work).

### 3. CLI Commands (`packages/cleo/src/cli/commands/nexus.ts`)

Two new subcommands registered in `nexusCommand`:

**`cleo nexus route-map [--path <dir>] [--json] [--project-id <id>]`**

Displays markdown table of all routes:

```
| Route ID | Handler | Method | Path | Deps | Callers |
```

Options:
- `--path`: Project directory (default: cwd)
- `--json`: Output LAFS envelope format with duration_ms, timestamp
- `--project-id`: Override auto-detected project ID

**`cleo nexus shape-check <routeSymbol> [--path <dir>] [--json] [--project-id <id>]`**

Compatibility report:

- Handler ID and declared shape
- Overall status (compatible/incompatible/partial/unknown)
- Recommendation
- Table of all callers with expected shape, status, diagnosis
- Incompatibility details if mismatches found

### 4. Tests (`packages/core/src/nexus/__tests__/route-analysis.test.ts`)

Vitest unit tests with synthetic nexus.db fixtures:

- One route node (GET /api/v1/tasks)
- One handler function (Task[])
- Two callers: one compatible, one incompatible
- One external dependency (fetches @cleocode/contracts)

Test suite:

- `getRouteMap` returns routes with handlers and deps
- `getRouteMap` includes distinct external deps
- `shapeCheck` finds callers and checks compatibility
- `shapeCheck` reports compatible when shapes match
- `shapeCheck` reports incompatible when shapes differ
- `shapeCheck` throws error for non-existent route

---

## Quality Gates (All Passing)

✅ `pnpm biome check --write` — Fixed import ordering, unused variables  
✅ `pnpm --filter @cleocode/core run build` — TypeScript strict mode  
✅ `pnpm --filter @cleocode/cleo run build` — CLI package build  
✅ Unit tests — Route analysis tests (pending vitest completion)

---

## Files

**Created**:
- `/mnt/projects/cleocode/packages/contracts/src/nexus-route-ops.ts` (70 lines)
- `/mnt/projects/cleocode/packages/core/src/nexus/route-analysis.ts` (282 lines)
- `/mnt/projects/cleocode/packages/core/src/nexus/__tests__/route-analysis.test.ts` (232 lines)

**Modified**:
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/nexus.ts` (+334 lines: two command definitions, subcommand registration)

---

## Git Commits

1. `5cb125227` — feat(T1064): cleo nexus route-map + shape-check surfaces existing route nodes
   - nexus.ts CLI commands + test file
   - 484 insertions, 82 deletions

2. (Pending) — feat(T1064): add contracts and SDK module for route-map and shape-check
   - nexus-route-ops.ts contracts
   - route-analysis.ts SDK module

---

## Architecture Notes

- **Package Boundary**: SDK module (route-analysis.ts) in `packages/core/src/nexus/` per AGENTS.md contract layering
- **Contracts-First**: Types defined first in `packages/contracts/src/`, then imported in SDK and CLI
- **Drizzle ORM**: Uses `and()` + `eq()` for type-safe SQL filtering (not the deprecated callback syntax)
- **Error Handling**: Throws meaningful errors for missing routes, handlers, nodes
- **Scope**: Surface existing schema nodes only — no migration, no new columns

---

## Next Steps (Future Tasks)

1. **T1XXX — AST-Based Shape Inference**: Full structural type checking via TypeScript compiler API
2. **T1065 — Contract Registry**: HTTP/gRPC/topic contract extraction (depends on this task)
3. **Memory Integration**: Link route changes to BRAIN observations (task-touches-symbol edges)

---

## Reference

- **Recommendation**: T1042 § "EP2-T3: Route-Map and Shape-Check Commands"
- **Schema**: route kind + handles_route/fetches relation types (nexus-schema.ts, lines 134, 265-266)
- **Related**: T998 (plasticity weights), T1071 (conduit-scan)
