# T510 — @cleocode/nexus Package

**Status**: complete
**Date**: 2026-04-11

## Summary

Created `packages/nexus/` as the new `@cleocode/nexus` package, housing
CLEO's code intelligence (tree-sitter AST pipeline) and the Drizzle schema for
a persistent symbol index. The package builds independently, passes all quality
gates, and integrates cleanly into the monorepo.

## Deliverables

### 1. packages/nexus/ — new package

```
packages/nexus/
├── package.json              @cleocode/nexus v0.1.0
├── tsconfig.json             ES2025, NodeNext, strict, composite
├── tsconfig.build.json       extends tsconfig.json, excludes tests
└── src/
    ├── index.ts              Public API barrel
    ├── internal.ts           Internal barrel (./internal subpath)
    ├── code/
    │   ├── index.ts          Code analysis barrel
    │   ├── tree-sitter-languages.ts  Language detection + grammar map
    │   ├── parser.ts         AST parser (native tree-sitter bindings)
    │   ├── outline.ts        smart_outline — structural skeleton
    │   ├── search.ts         smart_search — cross-codebase symbol search
    │   └── unfold.ts         smart_unfold — single symbol extraction
    ├── registry/
    │   └── index.ts          Stub explaining why registry stays in core
    └── schema/
        └── code-index.ts     NEW Drizzle SQLite schema for symbol index
```

### 2. Code moved (copied) from core

The code analysis files (`parser.ts`, `outline.ts`, `search.ts`, `unfold.ts`)
were moved from `packages/core/src/code/` and `packages/core/src/lib/tree-sitter-languages.ts`
into `packages/nexus/src/code/`. Import paths updated from `../lib/tree-sitter-languages.js`
to `./tree-sitter-languages.js`.

### 3. Backward-compat re-exports in core

`packages/core/src/code/index.ts` — replaced with re-exports from `@cleocode/nexus`.
`packages/core/src/internal.ts` — code analysis exports updated to source from `@cleocode/nexus`.
Original implementation files in `packages/core/src/code/` are retained (not deleted).

### 4. @cleocode/nexus added to core

`packages/core/package.json` — added `"@cleocode/nexus": "workspace:*"` to dependencies.
`packages/core/tsconfig.json` — added `{ "path": "../nexus" }` to project references.

### 5. pnpm-workspace.yaml

No changes needed — workspace uses `packages/*` glob, which automatically includes `packages/nexus`.

## Registry Migration Decision

The nexus registry code (`registry.ts`, `query.ts`, `permissions.ts`, `deps.ts`,
`discover.ts`, `workspace.ts`, `sharing/`, `transfer.ts`) **was not moved** because
it imports directly from core-internal modules:

- `../errors.js` (CleoError)
- `../logger.js` (getLogger)
- `../paths.js` (getCleoHome)
- `../store/data-accessor.js` (getAccessor, DataAccessor)
- `../store/nexus-schema.js` (Drizzle tables)
- `../store/nexus-sqlite.js` (getNexusDb)
- `../../config.js` (loadConfig — used by sharing module)

Moving these would require either duplicating core infrastructure or creating a
circular dependency (nexus → core → nexus). A `registry/index.ts` stub documents
this decision. Follow-up work to extract core infrastructure into smaller packages
would unblock a full registry migration.

## schema/code-index.ts (NEW)

Defines the `code_index` Drizzle SQLite table:

| Column | Type | Purpose |
|--------|------|---------|
| id | text PK | UUID v4 row ID |
| project_id | text NOT NULL | FK to project_registry |
| file_path | text NOT NULL | Relative path within project |
| symbol_name | text NOT NULL | AST-extracted name |
| kind | text NOT NULL | function/class/method/etc. |
| start_line | integer NOT NULL | 1-based start |
| end_line | integer NOT NULL | 1-based end |
| language | text NOT NULL | typescript/python/rust/etc. |
| exported | integer boolean | Has export modifier |
| parent | text | Parent class/struct name |
| return_type | text | Return type annotation |
| doc_summary | text | First line of JSDoc |
| indexed_at | text NOT NULL | ISO 8601 timestamp |

Exports: `codeIndex`, `CodeIndexRow`, `NewCodeIndexRow`.

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | Fixed 8 files, 0 errors |
| `packages/nexus` build | PASS — `tsc -p tsconfig.build.json` exits 0 |
| `packages/core` build | PASS — `tsc` exits 0 |
| Full workspace `pnpm run build` | PASS — Build complete |
| `pnpm run test` | PASS — 390 files, 7018 tests, 0 failures |

## Files Created

- `/mnt/projects/cleocode/packages/nexus/package.json`
- `/mnt/projects/cleocode/packages/nexus/tsconfig.json`
- `/mnt/projects/cleocode/packages/nexus/tsconfig.build.json`
- `/mnt/projects/cleocode/packages/nexus/src/index.ts`
- `/mnt/projects/cleocode/packages/nexus/src/internal.ts`
- `/mnt/projects/cleocode/packages/nexus/src/code/index.ts`
- `/mnt/projects/cleocode/packages/nexus/src/code/tree-sitter-languages.ts`
- `/mnt/projects/cleocode/packages/nexus/src/code/parser.ts`
- `/mnt/projects/cleocode/packages/nexus/src/code/outline.ts`
- `/mnt/projects/cleocode/packages/nexus/src/code/search.ts`
- `/mnt/projects/cleocode/packages/nexus/src/code/unfold.ts`
- `/mnt/projects/cleocode/packages/nexus/src/registry/index.ts`
- `/mnt/projects/cleocode/packages/nexus/src/schema/code-index.ts`

## Files Modified

- `/mnt/projects/cleocode/packages/core/package.json` — added `@cleocode/nexus` dep
- `/mnt/projects/cleocode/packages/core/tsconfig.json` — added nexus project reference
- `/mnt/projects/cleocode/packages/core/src/code/index.ts` — now re-exports from `@cleocode/nexus`
- `/mnt/projects/cleocode/packages/core/src/internal.ts` — code analysis exports now from `@cleocode/nexus`
