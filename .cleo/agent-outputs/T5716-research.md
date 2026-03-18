# T5716 Research Report — @cleocode/core Extraction

**Generated**: 2026-03-17
**Branch**: `feature/T5701-core-extraction`
**Purpose**: Foundation data for all T5716 implementation agents

---

## Section 1: packages/core Current State

### packages/core/package.json

```json
{
  "name": "@cleocode/core",
  "version": "1.0.0",
  "description": "CLEO core business logic — task management, sessions, brain memory, orchestration",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "echo '@cleocode/core: monorepo shell — full build in T5716' && exit 0",
    "typecheck": "echo '@cleocode/core: typecheck via root tsconfig' && exit 0"
  },
  "peerDependencies": {
    "@cleocode/caamp": "*",
    "@cleocode/contracts": "*",
    "@cleocode/lafs-protocol": "*"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "license": "MIT",
  "files": [
    "dist",
    "src"
  ]
}
```

**Key observations**:
- Build scripts are stubs (echo + exit 0) — need real build
- No runtime `dependencies` — only `peerDependencies`
- Missing runtime deps that core actually needs: `pino`, `env-paths`, `drizzle-orm`, `ajv`, `zod` (via drizzle-orm), etc.

### packages/core/tsconfig.json

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "../../",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false
  },
  "include": ["src/**/*"]
}
```

**Key observations**:
- `rootDir: "../../"` — set to monorepo root, not standalone
- `extends` root tsconfig — NOT standalone
- `include: ["src/**/*"]` — only includes `packages/core/src/` which is just the re-export barrel

### packages/core/src/ Files

Only 2 files exist:
- `packages/core/src/index.ts` — re-export barrel
- `packages/core/src/index.d.ts` — generated declaration

### packages/core/src/index.ts

```typescript
/**
 * @cleocode/core — CLEO core business logic package.
 *
 * Re-exports all public APIs from src/core/ via the root barrel export.
 * This package is a thin wrapper that makes the core layer consumable
 * as a standalone npm workspace package.
 *
 * Consumers: @cleocode/cleo (cli + mcp + dispatch layers)
 *
 * @package @cleocode/core
 * @epic T5701
 * @task T5713
 */

export * from '../../../src/core/index.js';
```

**This is the Option A re-export pattern from T5713** — it reaches up 3 levels to the monorepo root's `src/core/index.js`. This means `@cleocode/core` is NOT standalone; it's a thin re-export shell.

---

## Section 2: Circular Dependency Analysis (src/store/ → src/core/)

### Full import listing from src/store/*.ts → src/core/

#### Category A: CleoError / ExitCode imports (Wave1-B1)

| File | Import |
|------|--------|
| `src/store/lock.ts:9` | `import { CleoError } from '../core/errors.js'` |
| `src/store/json.ts:9` | `import { CleoError } from '../core/errors.js'` |
| `src/store/backup.ts:10` | `import { CleoError } from '../core/errors.js'` |
| `src/store/atomic.ts:13` | `import { CleoError } from '../core/errors.js'` |
| `src/store/import-sort.ts:13` | `import { CleoError } from '../core/errors.js'` |

**5 files** import CleoError from core/errors.

#### Category B: Logger imports (Wave1-B2)

| File | Import |
|------|--------|
| `src/store/safety-data-accessor.ts:17` | `import { getLogger } from '../core/logger.js'` |
| `src/store/data-safety.ts:15` | `import { getLogger } from '../core/logger.js'` |
| `src/store/data-safety-central.ts:19` | `import { getLogger } from '../core/logger.js'` |
| `src/store/sqlite.ts:38` | `import { getLogger } from '../core/logger.js'` |

**4 files** import getLogger from core/logger.

#### Category C: Path helper imports (Wave1-B3)

| File | Import |
|------|--------|
| `src/store/git-checkpoint.ts:19` | `import { getCleoDir, getConfigPath } from '../core/paths.js'` |
| `src/store/sqlite-backup.ts:15` | `import { getCleoDir } from '../core/paths.js'` |
| `src/store/brain-sqlite.ts:23` | `import { getCleoDirAbsolute } from '../core/paths.js'` |
| `src/store/nexus-sqlite.ts:22` | `import { getCleoHome } from '../core/paths.js'` |
| `src/store/migration-sqlite.ts:18` | `import { getCleoDirAbsolute } from '../core/paths.js'` |
| `src/store/sqlite.ts:39` | `import { getCleoDirAbsolute } from '../core/paths.js'` |
| `src/store/import-logging.ts:12` | `import { getLogPath } from '../core/paths.js'` |

**7 files** import path helpers from core/paths (note: `sqlite.ts` imports both logger AND paths).

#### Category D: Other core imports (Wave1-B4)

| File | Import |
|------|--------|
| `src/store/data-safety.ts:16` | `import { checkSequence, repairSequence } from '../core/sequence/index.js'` |
| `src/store/data-safety-central.ts:20` | `import { checkSequence, repairSequence } from '../core/sequence/index.js'` |
| `src/store/provider.ts:15-24` | **Type-only imports** from `../core/task-work/index.js` and `../core/tasks/*.js` (8 type imports) |

**provider.ts** has 8 imports but ALL are `import type` — these are erased at runtime and do NOT create circular runtime dependencies. Only `data-safety.ts` and `data-safety-central.ts` have runtime imports from `core/sequence/`.

### Summary: store → core Runtime Dependencies

| Category | Files | Runtime? |
|----------|-------|----------|
| CleoError (errors.ts) | 5 | YES |
| getLogger (logger.ts) | 4 | YES |
| Path helpers (paths.ts) | 7 | YES |
| sequence (sequence/index.js) | 2 | YES |
| Type-only (provider.ts) | 1 | NO (erased at compile time) |

**Total: 15 unique source files** with store→core imports (some files import multiple categories).
**Unique files with RUNTIME imports: 14** (excluding provider.ts type-only test files).

### Test files with store→core imports (informational, not blocking)

| File | Import |
|------|--------|
| `src/store/__tests__/project-registry.test.ts:8` | `import { generateProjectHash } from '../../core/nexus/hash.js'` |
| `src/store/__tests__/lifecycle-schema-parity.test.ts:4` | `import { CONTRIBUTION_STAGE, PIPELINE_STAGES } from '../../core/lifecycle/stages.js'` |

---

## Section 3: Core Module File Listing

### Top-level src/core/*.ts files (24 files)

```
src/core/audit-prune.ts
src/core/audit.ts
src/core/caamp-init.ts
src/core/config.ts
src/core/constants.ts
src/core/engine-result.ts
src/core/error-catalog.ts
src/core/error-registry.ts
src/core/errors.ts
src/core/hooks.ts
src/core/index.ts
src/core/init.ts
src/core/injection.ts
src/core/json-schema-validator.ts
src/core/logger.ts
src/core/output.ts
src/core/pagination.ts
src/core/paths.ts
src/core/platform.ts
src/core/project-info.ts
src/core/repair.ts
src/core/scaffold.ts
src/core/schema-management.ts
src/core/upgrade.ts
```

### Subdirectory file counts (330 total source files, excluding tests and .d.ts)

| Subdirectory | .ts Files |
|--------------|-----------|
| adapters | 4 |
| admin | 7 |
| adrs | 9 |
| caamp | 3 |
| codebase-map | 10 |
| compliance | 5 |
| context | 1 |
| hooks | 10 |
| inject | 1 |
| issue | 4 |
| lifecycle | 15 |
| mcp | 1 |
| memory | 18 |
| metrics | 10 |
| migration | 7 |
| nexus | 9 |
| observability | 5 |
| orchestration | 12 |
| otel | 1 |
| phases | 2 |
| pipeline | 2 |
| release | 10 |
| remote | 1 |
| research | 1 |
| roadmap | 1 |
| routing | 2 |
| security | 2 |
| sequence | 1 |
| sessions | 25 |
| signaldock | 6 |
| skills | 25 |
| snapshot | 1 |
| spawn | 2 |
| stats | 1 |
| sticky | 9 |
| system | 14 |
| task-work | 1 |
| tasks | 31 |
| templates | 2 |
| ui | 6 |
| validation | 29 |

**Total**: 330 source .ts files across 41 subdirectories + 24 top-level files = **354 source files in src/core/**.

---

## Section 4: Source Files for Primitives Extraction

### src/core/errors.ts (186 lines)

**Imports**:
- `@cleocode/lafs-protocol` (type-only: `LAFSError`, `LAFSErrorCategory`)
- `../types/exit-codes.js` (`ExitCode`, `getExitCodeName`, `isRecoverableCode`)
- `./error-catalog.js` (`getErrorDefinition`)

**Exports**:
- `ProblemDetails` interface
- `CleoError` class (extends Error)

**Key concern for primitives**: `CleoError` depends on `error-catalog.ts` and `../types/exit-codes.js`. A primitives version would need either:
1. A simplified `CleoError` without catalog/LAFS dependencies, OR
2. Copying `exit-codes.ts` and `error-catalog.ts` into primitives too

### src/core/logger.ts (159 lines)

**Imports**:
- `node:fs` (existsSync)
- `node:path` (dirname, join)
- `pino` (the logging library)

**Exports**:
- `LoggerConfig` interface
- `initLogger()` function
- `getLogger()` function
- `getLogDir()` function
- `closeLogger()` function

**Key concern**: Depends on `pino` (runtime npm dependency). A primitives version for store would only need `getLogger()`.

### src/core/paths.ts (372 lines)

**Imports**:
- `node:fs` (existsSync, readFileSync)
- `node:os` (homedir)
- `node:path` (dirname, join, resolve)
- `./system/platform-paths.js` (getPlatformPaths)

**Exports**: 29 functions including `getCleoHome`, `getCleoDir`, `getCleoDirAbsolute`, `getProjectRoot`, `getConfigPath`, `getLogPath`, etc.

**Key concern**: Depends on `./system/platform-paths.js` which depends on `env-paths` npm package. Functions used by store are: `getCleoDir`, `getCleoDirAbsolute`, `getCleoHome`, `getConfigPath`, `getLogPath`.

---

## Section 5: Consumer Import Counts

| Consumer Layer | Files importing from core/ | Total import lines |
|----------------|---------------------------|--------------------|
| `src/cli/` | 28 files | 63 import lines |
| `src/dispatch/` | 45 files | 171 import lines |
| `src/mcp/` | 10 files | 16 import lines |
| `tests/` | 6 files | 11 import lines |

**Dispatch is the heaviest consumer** with 171 import occurrences across 45 files.

### CLI files importing core/ (28 files)

```
src/cli/index.ts
src/cli/logger-bootstrap.ts
src/cli/renderers/index.ts
src/cli/renderers/error.ts
src/cli/commands/init.ts
src/cli/commands/docs.ts
src/cli/commands/extract.ts
src/cli/commands/migrate-claude-mem.ts
src/cli/commands/config.ts
src/cli/commands/sticky.ts
src/cli/commands/upgrade.ts
src/cli/commands/token.ts
src/cli/commands/self-update.ts
src/cli/commands/web.ts
src/cli/commands/mcp-install.ts
src/cli/commands/env.ts
src/cli/commands/refresh-memory.ts
src/cli/commands/checkpoint.ts
src/cli/commands/generate-changelog.ts
src/cli/commands/install-global.ts
src/cli/commands/restore.ts
src/cli/commands/list.ts
src/cli/commands/otel.ts
src/cli/commands/find.ts
src/cli/commands/remote.ts
src/cli/commands/observe.ts
src/cli/commands/__tests__/init-gitignore.test.ts
src/cli/commands/__tests__/nexus.test.ts
```

### Test files importing core/ (6 files)

```
tests/integration/signaldock-integration.test.ts
tests/integration/adapter-lifecycle.test.ts
tests/integration/hook-wiring.integration.test.ts
tests/integration/session-memory.integration.test.ts
tests/e2e/signaldock-orchestration.test.ts
tests/e2e/rcasd-pipeline-e2e.test.ts
```

---

## Section 6: Root package.json Dependency Versions

| Package | Version |
|---------|---------|
| `drizzle-orm` | `1.0.0-beta.15-859cf75` |
| `sql.js` | `^1.14.0` |
| `sqlite-vec` | `^0.1.7-alpha.2` |
| `ajv` | `^8.18.0` |
| `ajv-formats` | `^3.0.1` |
| `env-paths` | `^4.0.0` |
| `pino` | `^10.3.1` |
| `pino-roll` | `^4.0.0` |
| `@cleocode/lafs-protocol` | `^1.7.0` |
| `@cleocode/caamp` | `^1.7.0` |
| `commander` | `^12.1.0` |
| `js-tiktoken` | `^1.0.21` |
| `proper-lockfile` | `^4.1.2` |
| `write-file-atomic` | `^6.0.0` |
| `yaml` | `^2.8.2` |

**Note**: `@cleocode/contracts` is a workspace package (not in dependencies), listed in `workspaces` array. `better-sqlite3` is NOT a dependency — the project uses `sql.js` instead.

---

## Section 7: build.mjs adapterMap

```javascript
const adapterMap = {
  '@cleocode/adapter-claude-code': resolve(__dirname, 'packages/adapters/claude-code/src/index.ts'),
  '@cleocode/adapter-opencode': resolve(__dirname, 'packages/adapters/opencode/src/index.ts'),
  '@cleocode/adapter-cursor': resolve(__dirname, 'packages/adapters/cursor/src/index.ts'),
  '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
};
```

**Note**: `@cleocode/core` is NOT in the adapterMap. It will need to be added when the package becomes a real standalone build target (Wave6-G1).

**Entry points**:
```javascript
entryPoints: [
  { in: 'src/cli/index.ts', out: 'cli/index' },
  { in: 'src/mcp/index.ts', out: 'mcp/index' },
],
```

---

## Section 8: vitest.config.ts Aliases

```typescript
resolve: {
  alias: {
    "node:sqlite": "node:sqlite",
    "@cleocode/adapter-claude-code": resolve("packages/adapters/claude-code/src/index.ts"),
    "@cleocode/adapter-opencode": resolve("packages/adapters/opencode/src/index.ts"),
    "@cleocode/adapter-cursor": resolve("packages/adapters/cursor/src/index.ts"),
    "@cleocode/contracts": resolve("packages/contracts/src/index.ts"),
  },
},
```

**Note**: `@cleocode/core` is NOT in the vitest aliases. Will need adding in Wave6-G2.

---

## Section 9: src/core/index.ts (Barrel Export)

The file is 280 lines. It exports:
- **40 namespace re-exports** (`export * as adapters from ...`, `export * as tasks from ...`, etc.)
- **~80 named re-exports** from top-level utility files (errors, logger, paths, config, init, scaffold, platform, etc.)

All 40 subdirectory modules are re-exported as namespaces. All 24 top-level files have selected named exports.

---

## Section 10: Current TSC State

```
npx tsc --noEmit
```

**Result: CLEAN** — no errors. TypeScript compilation passes with zero errors on the current branch.

---

## Section 11: src/store/ File Listing

**39 source files** (excluding tests and .d.ts):

```
src/store/atomic.ts
src/store/backup.ts
src/store/brain-accessor.ts
src/store/brain-schema.ts
src/store/brain-sqlite.ts
src/store/cache.ts
src/store/chain-schema.ts
src/store/converters.ts
src/store/data-accessor.ts
src/store/data-safety-central.ts
src/store/data-safety.ts
src/store/db-helpers.ts
src/store/export.ts
src/store/file-utils.ts
src/store/git-checkpoint.ts
src/store/import-logging.ts
src/store/import-remap.ts
src/store/import-sort.ts
src/store/index.ts
src/store/json.ts
src/store/lifecycle-store.ts
src/store/lock.ts
src/store/migration-sqlite.ts
src/store/nexus-schema.ts
src/store/nexus-sqlite.ts
src/store/node-sqlite-adapter.ts
src/store/parsers.ts
src/store/project-detect.ts
src/store/provider.ts
src/store/safety-data-accessor.ts
src/store/schema.ts
src/store/session-store.ts
src/store/sqlite-backup.ts
src/store/sqlite-data-accessor.ts
src/store/sqlite.ts
src/store/status-registry.ts
src/store/task-store.ts
src/store/tasks-schema.ts
src/store/validation-schemas.ts
```

---

## Section 12: Drizzle Config Files

| Config File | Schema Path | Output Dir |
|-------------|-------------|------------|
| `drizzle-tasks.config.ts` | `./src/store/tasks-schema.ts` | `./migrations/drizzle-tasks` |
| `drizzle-brain.config.ts` | `./src/store/brain-schema.ts` | `./migrations/drizzle-brain` |
| `drizzle-nexus.config.ts` | `./src/store/nexus-schema.ts` | `./migrations/drizzle-nexus` |

**Impact for Wave2**: When store files move to `packages/core/src/store/`, these config paths must update (Wave4-E3).

---

## Section 13: .cleo/agent-outputs/ Directory

**Directory exists** with 107 files. The report file `T5716-research.md` is being written here.

---

## Summary: Critical Findings for Implementation Agents

### Wave 0 (Primitives)
- `errors.ts` depends on `error-catalog.ts` and `../types/exit-codes.ts` — need to extract those too or create simplified primitives
- `logger.ts` depends only on `pino` (npm) — clean extraction
- `paths.ts` depends on `./system/platform-paths.ts` which depends on `env-paths` (npm) — need to include platform-paths

### Wave 1 (Break store→core cycles)
- **14 source files** in `src/store/` have runtime imports from `src/core/`
- The 3 primitive categories (errors, logger, paths) cover 12 of the 14 files
- 2 files (`data-safety.ts`, `data-safety-central.ts`) also import `core/sequence/` — these need separate handling
- `provider.ts` has type-only imports — no runtime cycle, but paths still need updating

### Wave 2 (Move store)
- 39 source files to move
- 3 drizzle config files reference `./src/store/` schema paths

### Wave 3 (Move core modules)
- 354 source files across 41 subdirectories + top-level
- Most consumers are in dispatch (45 files, 171 imports)

### Wave 5 (Rewire imports)
- 28 CLI files, 45 dispatch files, 10 MCP files, 6 test files need import path updates

### Wave 6 (Build integration)
- `build.mjs` adapterMap needs `@cleocode/core` entry
- `vitest.config.ts` aliases need `@cleocode/core` entry
- `packages/core/tsconfig.json` needs standalone rootDir and include paths
