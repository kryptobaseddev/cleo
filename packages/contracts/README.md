# @cleocode/contracts

Canonical wire-format type surface for the CLEO ecosystem. All operation `Params`/`Result` types, domain discriminated unions, LAFS envelope types, and shared primitives live here — making this package the **SSoT** (single source of truth) for every CLEO dispatch operation.

## Position in the Architecture

`@cleocode/contracts` is the **leaf package** in the CLEO dependency graph — it has zero runtime dependencies. Every other CLEO package imports from here; nothing here imports from them.

```
packages/contracts/          ← wire-format SSoT (this package)
   └── src/operations/       ← <Domain>Ops discriminated unions + Params/Result types
packages/core/               ← SDK implementation (imports Params/Result from here)
packages/cleo/               ← CLI dispatch (imports XOps + OpsFromCore from here)
packages/cleo-os/            ← harness adapters (imports adapter contracts from here)
packages/studio/             ← Studio routes (imports operation types from here)
```

Per **ADR-057** (Contracts/Core SSoT layering), every Core function that backs a dispatch operation MUST import its `<Op>Params` and `<Op>Result` types from this package. Per **ADR-058** (Dispatch Type Inference via `OpsFromCore<C>`), dispatch handlers derive their full type-safety from these contracts rather than declaring parallel types inline.

## The `<Op>Params` / `<Op>Result` Pattern

Each dispatch-ready operation is represented by a pair of types:

- **`<Op>Params`** — the wire-format input shape the CLI/Studio/SDK sends to Core.
- **`<Op>Result`** — the wire-format output shape Core returns (wrapped in a `LafsEnvelope`).

These pairs are collected into a **`<Domain>Ops` discriminated union** (a plain TypeScript record type). The union maps operation names to `readonly [Params, Result]` tuples:

```typescript
// packages/contracts/src/operations/tasks.ts
export type TasksOps = {
  readonly show:     readonly [TasksShowParams,    TasksShowResult];
  readonly list:     readonly [TasksListParams,    TasksListResult];
  readonly find:     readonly [TasksFindParams,    TasksFindResult];
  readonly add:      readonly [TasksAddParams,     TasksAddResult];
  readonly update:   readonly [TasksUpdateQueryParams, TasksUpdateQueryResult];
  readonly complete: readonly [TasksCompleteQueryParams, TasksCompleteQueryResult];
  // ... (all operations in the tasks domain)
};
```

The dispatch layer uses `TypedDomainHandler<TasksOps>` to get compile-time narrowing on every branch. When a Params or Result type changes in this file, TypeScript surfaces the break immediately at every call site — no silent drift.

### `OpsFromCore<C>` — Inference Helper

For domains where Core functions already follow the ADR-057 D1 uniform signature (`async fn(projectRoot: string, params: <Op>Params): Promise<<Op>Result>`), the dispatch layer can skip writing a manual `<Domain>Ops` type. Instead it uses `OpsFromCore<C>` (defined in `packages/cleo/src/dispatch/adapters/typed.ts`, introduced in T1436) to **infer** the Params/Result pairs directly from the Core function signatures:

```typescript
import type { OpsFromCore } from '@cleocode/cleo/dispatch/adapters/typed';
import * as taskCore from '@cleocode/core/tasks';

// Automatically derives TasksOps-equivalent types from Core's signatures.
type InferredTasksOps = OpsFromCore<typeof taskCore>;
```

The contracts package supplies the `Params`/`Result` types that Core functions are annotated with — so `OpsFromCore<C>` and the hand-written `<Domain>Ops` type stay in sync automatically.

See **ADR-058** for the full migration recipe, tier classification (thin wrapper / engine wrapper / manual `TypedOpRecord`), and escape hatches.

## Usage Examples

### 1. Importing operation types for a tasks domain handler

```typescript
import type {
  TasksOps,
  TasksAddParams,
  TasksAddResult,
  TasksShowParams,
  TasksShowResult,
} from '@cleocode/contracts';

// Use in a TypedDomainHandler — params/result are compile-time checked.
async function addTask(
  projectRoot: string,
  params: TasksAddParams,
): Promise<TasksAddResult> {
  // ...implementation...
}
```

### 2. Importing session operation types and the `SessionOps` union

```typescript
import type {
  SessionOps,
  SessionStartParams,
  SessionStartResult,
  SessionEndParams,
  SessionEndResult,
} from '@cleocode/contracts';

// SessionOps is the discriminated union consumed by TypedDomainHandler<SessionOps>.
// Keying into it gives the exact [Params, Result] tuple for each operation.
type StartTuple = SessionOps['start'];
//   ^ readonly [SessionStartParams, SessionStartResult]
```

### 3. Working with LAFS envelopes and exit codes

```typescript
import {
  isLafsSuccess,
  isLafsError,
  ExitCode,
  isSuccessCode,
  type LafsEnvelope,
} from '@cleocode/contracts';

function handleCLIResponse(response: LafsEnvelope<unknown>, code: number): void {
  if (isLafsSuccess(response)) {
    console.log('data:', response.data);
  } else if (isLafsError(response)) {
    console.error('error:', response.error.message);
  }

  if (!isSuccessCode(code)) {
    process.exit(code);
  }
}
```

## Versioning Policy

`@cleocode/contracts` follows **CalVer `YYYY.MM.patch`** (e.g., `2026.4.151`). The version is the calendar position of the release, not a semantic compatibility signal. Breaking changes to operation types (renamed fields, removed Params properties) are tracked via ADR entries and announced in the CHANGELOG. Consumers should pin to a specific version and review the CHANGELOG on upgrades.

The package is published to npm with `"access": "public"` — see `publishConfig` in `package.json`. It is **not** marked `"private"`.

## Sub-path Exports

The package exposes several sub-path entry points in addition to the root `"."`:

| Sub-path | Contents |
|---|---|
| `.` (root) | All domain types, LAFS envelope types, exit codes, status registry, and re-exported operation types (`ops.*`, `TasksOps`, `SessionOps`, …) |
| `./operations/*` | Individual operation files by domain (e.g., `./operations/tasks`, `./operations/session`) |
| `./nexus-contract-ops` | Nexus contract operation types |
| `./nexus-living-brain-ops` | BRAIN super-domain living-brain operation types |
| `./nexus-query-ops` | Nexus query operation types |
| `./nexus-route-ops` | Nexus route operation types |
| `./nexus-tasks-bridge-ops` | Nexus–Tasks bridge operation types |

Example:

```typescript
// Root import — preferred for most consumers
import type { TasksOps, TasksAddParams } from '@cleocode/contracts';

// Sub-path import — useful when you need tree-shaking at the type level
import type { TasksOps } from '@cleocode/contracts/operations/tasks';
```

## ADR Cross-References

| ADR | Topic |
|---|---|
| [ADR-057](../../docs/adr/ADR-057-contracts-core-ssot.md) | Contracts/Core SSoT layering — uniform `(projectRoot, params)` Core API and `OpsFromCore`-inferred dispatch |
| [ADR-058](../../docs/adr/ADR-058-dispatch-type-inference.md) | Dispatch type inference via `OpsFromCore<C>` — pattern, migration recipe, escape hatches |
| [ADR-039](../../docs/adr/ADR-039-lafs-envelope-spec.md) | LAFS envelope format — `LafsEnvelope<T>`, `LafsSuccess`, `LafsError` |
| [ADR-056](../../docs/adr/ADR-056-db-ssot.md) | DB SSoT layering (supplements the contracts SSoT for storage types) |

## API Overview

### Operation Types (Wire Format)

All domains follow the `<Op>Params` / `<Op>Result` naming convention. Available domain operation files under `src/operations/`:

| Domain file | `XOps` type | Description |
|---|---|---|
| `tasks.ts` | `TasksOps` | Task CRUD, query, lifecycle, sync, claim |
| `session.ts` | `SessionOps` | Session start/end/resume, briefing, handoff |
| `brain.ts` | — | BRAIN super-graph wire types |
| `memory.ts` | `MemoryOps` | Observations, patterns, decisions, tiers |
| `nexus.ts` | `NexusOps` | Code intelligence, wiki, impact |
| `lifecycle.ts` | `LifecycleOps` | Epic lifecycle pipeline stages |
| `orchestrate.ts` | `OrchestrateOps` | Multi-agent spawn, wave, IVTR, playbook |
| `pipeline.ts` | — | LOOM pipeline wave types |
| `admin.ts` | `AdminOps` | Backup, restore, export, import |
| `validate.ts` | `CheckOps` | Evidence gates, verification |
| `release.ts` | `ReleaseOps` | CalVer release and tag |
| `sentient.ts` | `SentientOps` | Tier-2 proposal management |
| `conduit.ts` | `ConduitOps` | Messaging transport |
| `research.ts` | `ResearchOps` | LOOM research stage |
| `skills.ts` | `SkillsOps` | Agent skill management |
| `playbook.ts` | `PlaybookOps` | `.cantbook` playbook execution |
| `worktree.ts` | `WorktreeOps` | Git worktree provisioning |
| `issues.ts` | `IssuesOps` | GitHub issue sync |
| `system.ts` | `SystemOps` | System health and diagnostics |
| `sticky.ts` | `StickyOps` | Sticky note capture |

### LAFS Envelope Types

Standardized response envelope (per ADR-039):

```typescript
import type { LafsEnvelope, LafsSuccess, LafsError } from '@cleocode/contracts';
import { isLafsSuccess, isLafsError } from '@cleocode/contracts';
```

### Core Domain Types

```typescript
import type {
  Task, TaskCreate, TaskPriority, TaskStatus, TaskType, TaskSize,
  Session, SessionScope,
  DataAccessor, TransactionAccessor,
  CleoConfig,
  BrainEntryRef,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
```

### Status Registry

```typescript
import {
  TASK_STATUSES,
  isValidStatus,
  TASK_STATUS_SYMBOLS_UNICODE,
} from '@cleocode/contracts';
```

### Exit Codes

```typescript
import { ExitCode, isSuccessCode, isErrorCode, getExitCodeName } from '@cleocode/contracts';
```

## Dependencies

This package has **no runtime dependencies**. It is a pure TypeScript type and constant library. The only dev dependency is `vitest` for schema validation tests.

## License

MIT — see [LICENSE](../../LICENSE) for details.
