# @cleocode/core Subpath Stability Contract

> This document is the authoritative reference for every subpath exported by
> the `@cleocode/core` package. It defines which subpaths are **stable**,
> which are **internal**, and which are **peer-dep-gated**, along with the
> breaking-change policy that applies to each tier.
>
> Inspired by, and structurally mirrors, [`llmtxt/STABILITY.md`][llmtxt].
>
> [llmtxt]: https://github.com/kryptobaseddev/llmtxt/blob/main/packages/llmtxt/STABILITY.md

---

## Rationale

`@cleocode/core` **is** the CLEO SDK.

After the Round 2 CLI audit (2026-04-17, T948) we deliberately **rejected**
creating a separate `packages/cleo-sdk/` wrapper. The `Cleo` facade
(`packages/core/src/cleo.ts`) already wraps the free functions that every
dispatch-engine and the CLI itself rely on. Adding another wrapper-around-a-
wrapper would create a three-surface pyramid (free funcs → facade → sdk) and
invite drift. Instead, `@cleocode/core` is promoted to the single canonical
SDK surface by:

1. Declaring **per-subpath** exports in `package.json` (see §Subpath inventory).
2. Publishing this stability contract covering every stable subpath.
3. Snapshotting each stable subpath's `.d.ts` into `.dts-snapshots/` so breaking
   changes are caught at CI time (`scripts/generate-dts-snapshots.sh --check`).
4. Running a `subpath-contract.test.ts` that asserts every declared subpath
   resolves and its exports match the snapshot.

Consumers (CLI, Studio, OpenClaw, third-party agents) **SHOULD** import from
the narrowest subpath that satisfies their need.

---

## Versioning scheme

`@cleocode/core` uses **CalVer** (`YYYY.M.PATCH`).

| Change class | Version behaviour |
|---|---|
| Non-breaking addition (new exports on a stable subpath) | Bump `PATCH` only |
| Breaking change to a **stable** subpath | Requires a CalVer **month bump** (e.g., `2026.5.x`) — never silently in a PATCH |
| Breaking change to an **internal** subpath | Allowed with `PATCH` bump; documented in CHANGELOG |
| Removal of a **deprecated** symbol | Requires at least one **minor-version notice** (i.e. appears in a CHANGELOG entry and the STABILITY.md "Currently deprecated" table one release cycle before removal) |

A "breaking change" is any modification to a stable subpath that would cause
existing consumers to fail TypeScript compilation or produce different runtime
behaviour without a code change on their part. This includes:

- Removing or renaming an exported symbol
- Narrowing the type of a parameter (stricter input)
- Widening the type of a return value (looser output)
- Changing the observable runtime behaviour of a function
- Removing an export entry from `package.json` `"exports"`

---

## Stability tiers

| Tier | Meaning |
|---|---|
| **stable** | Fully supported. Breaking changes require a CalVer month bump and must appear in CHANGELOG and the "Currently deprecated" table at least one minor-version cycle in advance. Covered by `.dts-snapshots/` and contract tests. |
| **internal** | Not part of the public API. May be removed or reshaped at any time without notice. Consumed exclusively by sibling CLEO packages (e.g. `@cleocode/cleo`). Third-party code **MUST NOT** import from these subpaths. |
| **peer-dep-gated** | Stable **as a contract**, but requires a peer dependency or runtime adapter to be useful. Importing without the gate is safe but calls will throw at runtime. |

---

## Subpath inventory

### `.` — root (`@cleocode/core`)

**Tier**: stable

The default entry point. Re-exports every domain namespace plus the
`@cleocode/contracts` type system. Best choice when you need several
domains and do not care about the cost of wildcard tree-shaking.

| Export | Kind |
|---|---|
| `Cleo` | class (facade — also at `./sdk`) |
| `tasks`, `sessions`, `memory`, `orchestration`, `lifecycle`, `release`, `admin`, `sticky`, `nexus`, `agents`, `intelligence`, … | namespace re-exports |
| `addTask`, `listTasks`, `findTasks`, `showTask`, `updateTask`, `deleteTask`, `completeTask` | flat function re-exports |
| (all types from `@cleocode/contracts`) | types |

---

### `./sdk`

**Tier**: stable

The `Cleo` facade plus its domain API types. The narrowest, fastest-loading
entry point for **programmatic consumers** (Studio, OpenClaw, external agents,
notebooks, smoke tests). Prefer this over `.` when you only need the facade.

| Export | Kind |
|---|---|
| `Cleo` | class |
| `CleoInitOptions` | type |
| `TasksAPI`, `SessionsAPI`, `MemoryAPI`, `OrchestrationAPI`, `LifecycleAPI`, `ReleaseAPI`, `AdminAPI`, `StickyAPI`, `NexusAPI`, `SyncAPI`, `AgentsAPI`, `IntelligenceAPI` | types |

Contract: `Cleo.init(projectRoot, options?)` MUST return a ready facade that
delegates to the bundled SQLite store unless `options.store` is supplied.

---

### `./internal`

**Tier**: internal

Superset of `./`. Used exclusively by `@cleocode/cleo` (the CLI package) and
any sibling package that needs the unwrapped, flat function surface required
by the dispatch engine and engine adapters.

**Third-party code MUST NOT import this subpath.** No snapshot is enforced;
exports may change with a PATCH bump.

---

### `./contracts`

**Tier**: stable

Pure re-export of `@cleocode/contracts`. Gives SDK consumers a stable type-
only import without pulling in the runtime kernel. Ideal for type-only
workspaces, `.d.ts`-only packages, and validation tooling.

| Export | Kind |
|---|---|
| (all types from `@cleocode/contracts`) | types |

---

### `./tasks`

**Tier**: stable

Direct access to the tasks domain — CRUD, lifecycle, dependencies, archival,
hierarchy, graph ops. Equivalent to `import { tasks } from '@cleocode/core'`
but narrower.

| Export | Kind |
|---|---|
| `addTask`, `showTask`, `listTasks`, `findTasks`, `updateTask`, `deleteTask`, `completeTask`, `startTask`, `archiveTasks`, … | functions |
| (task-related types from `@cleocode/contracts`) | types |

Contract: every task function MUST accept an optional `projectRoot` +
`DataAccessor` so consumers can share stores across facade instances.

---

### `./memory`

**Tier**: stable (peer-dep-gated on SQLite + WASM embeddings)

Brain storage, search, observation, timeline, lifecycle, consolidation, and
STDP plasticity. The narrowest entry for agents that only need memory.

| Export | Kind |
|---|---|
| `observeBrain`, `searchBrain`, `searchBrainCompact`, `timelineBrain`, `fetchBrainEntries`, `memoryObserve`, `memoryFind`, `memoryShow`, `memoryTimeline`, … | functions |
| (memory-related types from `@cleocode/contracts`) | types |

---

### `./sessions`

**Tier**: stable

Session lifecycle — start, resume, end, checkpoint, briefing, handoff, debrief,
and decision/assumption logging.

| Export | Kind |
|---|---|
| `startSession`, `endSession`, `resumeSession`, `listSessions`, `showSession`, `switchSession`, `getCurrentSessionId`, `computeBriefing`, `computeDebrief`, `computeHandoff`, … | functions |
| (session-related types from `@cleocode/contracts`) | types |

---

### `./nexus`

**Tier**: stable (peer-dep-gated on `@cleocode/nexus`)

Cross-project sync, registry, permissions, discovery, and bridge generation.

| Export | Kind |
|---|---|
| `nexusInit`, `nexusRegister`, `nexusUnregister`, `nexusList`, `nexusSync`, `nexusSyncAll`, `nexusReconcile`, `searchAcrossProjects`, `discoverRelated`, `resolveTask`, `validateSyntax`, `setPermission`, … | functions |
| `NexusProject`, `NexusProjectStats`, `NexusPermissionLevel` | types |

---

### `./lifecycle`

**Tier**: stable

Pipeline stages, gates, IVTR loop, tessera templates, stage guidance, and
lifecycle chain stores.

| Export | Kind |
|---|---|
| `PIPELINE_STAGES`, `STAGE_ALIASES`, `STAGE_SKILL_MAP`, `TIER_0_SKILLS`, `isValidStage`, `resolveStageAlias`, `checkGate`, `passGate`, `failGate`, `skipStageWithReason`, `getLifecycleStatus`, `getLifecycleHistory`, `getLifecycleGates`, `recordStageProgress`, `buildStageGuidance`, `renderStageGuidance`, `formatStageGuidance`, `listEpicsWithLifecycle`, `resetStage`, `checkStagePrerequisites`, `getStagePrerequisites`, `instantiateTessera`, `showTessera`, `listTesseraTemplates`, … | functions / consts |
| `Stage`, `StageGuidance` | types |

---

### `./conduit`

**Tier**: stable (peer-dep-gated on a running conduit database)

Cross-project messaging primitives. Separate from the main inventory because
it predates T948; kept here for completeness.

See `src/conduit/index.ts` for the exact export list. Considered stable as
of `2026.4.x`; covered by the contract test suite.

---

### `./store/*`, `./conduit/*`, `./*`

**Tier**: internal

Deep-path wildcard exports for sibling CLEO packages. **Not part of the
stable surface.** Do not rely on these in third-party code.

---

## CI enforcement

Two mechanisms enforce this contract:

1. **`.dts-snapshots/` baseline** — `scripts/generate-dts-snapshots.sh` writes
   a copy of each stable subpath's compiled `.d.ts` into the repo. Running
   the same script with `--check` (invoked from CI) diffs the current build
   against the snapshots and exits non-zero on any breaking structural
   change.

2. **Contract tests** — `src/__tests__/subpath-contract.test.ts` asserts:
   - Every declared subpath in `package.json.exports` resolves to a real file
     on disk.
   - `import('@cleocode/core/sdk')` returns the `Cleo` class.
   - Each snapshot file exists, is non-empty, and matches the current build.
   - No stable subpath is missing from the snapshot directory.

Snapshot baseline is regenerated by running:

```bash
./packages/core/scripts/generate-dts-snapshots.sh
```

Commit the updated snapshot files together with your source changes.
CI runs:

```bash
./packages/core/scripts/generate-dts-snapshots.sh --check
```

---

## Deprecation policy

When a stable symbol is scheduled for removal:

1. Mark it `@deprecated` in TSDoc with a replacement suggestion.
2. Add an entry to the **Currently deprecated exports** table below.
3. Mention the deprecation in `CHANGELOG.md` for the release that introduces
   the notice.
4. Wait **at least one minor (CalVer-month) version cycle** before removing.
5. The actual removal commit MUST bump the CalVer month and update
   `.dts-snapshots/` along with the new export list in this file.

---

## Currently deprecated exports

| Symbol / Subpath | Deprecated in | Removal target | Replacement |
|---|---|---|---|
| _(none at the time of writing)_ | — | — | — |

---

## Consumer guidance

| If you are building… | Import from |
|---|---|
| The CLI (internal) | `@cleocode/core/internal` |
| An external agent / SDK consumer | `@cleocode/core/sdk` |
| A type-only validator / doc tool | `@cleocode/core/contracts` |
| A memory-only helper | `@cleocode/core/memory` |
| A task-scoped script | `@cleocode/core/tasks` |
| Studio UI panels | `@cleocode/core/sdk` (+ narrow subpaths as needed) |
| OpenClaw runtime ([issue #97]) | `@cleocode/core/sdk` |

[issue #97]: https://github.com/kryptobaseddev/cleo/issues/97

---

_Last updated: 2026-04-17 (T948)_
