# @cleocode/core — CLEO SDK

CLEO core business logic kernel **and canonical SDK surface** — tasks, sessions, memory, orchestration, lifecycle, with bundled SQLite store.

> **`@cleocode/core` IS the CLEO SDK.** There is no separate `@cleocode/cleo-sdk` package. The `Cleo` facade, domain namespaces, and flat free functions are all exposed through per-subpath exports that follow a CalVer stability contract. See [STABILITY.md](./STABILITY.md) for the full contract and `.dts-snapshots/` for the enforced baseline.

## Quickstart

```ts
import { startSession } from '@cleocode/core/sessions';
import { addTask } from '@cleocode/core/tasks';

const projectRoot = process.cwd();

// Open a session before performing mutations
const session = await startSession(projectRoot, { scope: 'global', name: 'my-session' });

// Add a task
const task = await addTask(
  { title: 'My task', type: 'task', priority: 'medium' },
  projectRoot,
);
```

Or use the `Cleo` facade for a project-bound, domain-grouped interface:

```ts
import { Cleo } from '@cleocode/core/sdk';

const cleo = await Cleo.init(process.cwd());

const session = await cleo.sessions.start({ scope: 'global', name: 'my-session' });
const task    = await cleo.tasks.add({ title: 'My task', type: 'task', priority: 'medium' });

await cleo.destroy();
```

## Installation

```bash
# npm
npm install @cleocode/core

# pnpm (recommended)
pnpm add @cleocode/core

# yarn
yarn add @cleocode/core
```

**Node.js requirement**: `>=24.0.0`

## Available namespaces

### Primary dispatch domains (9)

These domains map 1:1 to the CLEO CLI dispatch surface and follow the uniform
`(projectRoot: string, params: <Op>Params) => Promise<<Op>Result>` signature
mandated by [ADR-057](../../docs/adr/ADR-057-contracts-core-ssot.md).

| Domain | Subpath | Purpose |
|--------|---------|---------|
| `admin` | `@cleocode/core/admin` | Import/export, project health checks, backup |
| `check` | `@cleocode/core` *(via internal)* | Protocol compliance, canon validation |
| `conduit` | `@cleocode/core/conduit` | Inter-agent messaging, local transport |
| `nexus` | `@cleocode/core/nexus` | Code-intelligence graph, cross-project linking |
| `pipeline` | `@cleocode/core/pipeline` | RCASD/IVTR pipeline stage management |
| `playbook` | `@cleocode/core` *(via internal)* | `.cantbook` playbook runtime |
| `sentient` | `@cleocode/core/sentient` | Tier-2 autonomous proposals, sentient daemon |
| `sessions` | `@cleocode/core/sessions` | Session lifecycle, briefing, handoff |
| `tasks` | `@cleocode/core/tasks` | Task CRUD, dependencies, lifecycle, archival |

### Supporting domains

| Domain | Subpath | Purpose |
|--------|---------|---------|
| `gc` | `@cleocode/core/gc` | Garbage-collection daemon, transcript pruning |
| `llm` | `@cleocode/core` | LLM-extraction, transcript ingestion, brain backfill |
| `memory` | `@cleocode/core/memory` | BRAIN storage, search, STDP, observation |
| `lifecycle` | `@cleocode/core/lifecycle` | Gate verification, evidence, pipeline stages |
| `harness` | `@cleocode/core/harness` | CleoOS adapter surface, Pi harness integration |

## Subpath exports

Prefer the **narrowest** subpath that satisfies your need — it reduces import cost and is covered by snapshot-enforced stability gates.

| Subpath | Tier | Use when |
|---------|------|----------|
| `@cleocode/core/sdk` | stable | External agents, Studio panels — `Cleo` facade only |
| `@cleocode/core/tasks` | stable | Task CRUD, hierarchy, graph ops |
| `@cleocode/core/sessions` | stable | Session lifecycle, briefing, handoff |
| `@cleocode/core/memory` | stable | Brain observe/search/timeline |
| `@cleocode/core/nexus` | stable | Code-intelligence graph queries |
| `@cleocode/core/lifecycle` | stable | Gate verification, pipeline stages |
| `@cleocode/core/conduit` | stable | Conduit messaging |
| `@cleocode/core/sentient` | stable | Sentient daemon, proposals |
| `@cleocode/core/gc` | stable | Garbage-collection daemon |
| `@cleocode/core/contracts` | stable | Pure `@cleocode/contracts` re-export (types only) |
| `@cleocode/core` | stable | All namespaces + flat free functions |
| `@cleocode/core/internal` | **internal** | CLI dispatch only — do NOT import from third-party code |

See [STABILITY.md](./STABILITY.md) for the full tier definitions and breaking-change policy.

## Type definitions

All param/result types live in [`@cleocode/contracts`](../contracts/README.md) and are
re-exported from `@cleocode/core/contracts`:

```ts
import type { TasksAddParams, SessionStartParams } from '@cleocode/core/contracts';
// or directly:
import type { TasksAddParams } from '@cleocode/contracts';
```

Do **not** inline or mock types — always import from `@cleocode/contracts`.

## Usage examples

### Task operations

```ts
import { tasksAddOp, tasksShowOp, tasksListOp, tasksCompleteOp } from '@cleocode/core/tasks';

const root = process.cwd();

const task = await tasksAddOp(root, {
  title: 'Implement login endpoint',
  type: 'task',
  priority: 'high',
  size: 'medium',
  parent: 'T1000',            // optional parent task/epic ID
  depends: ['T1001'],         // optional dependency list
});

const detail  = await tasksShowOp(root,     { taskId: task.data.id });
const list    = await tasksListOp(root,     { status: ['pending', 'in_progress'] });
await tasksCompleteOp(root, { taskId: task.data.id });
```

### Session operations

```ts
import { startSession, endSession, sessionStatus } from '@cleocode/core/sessions';

const root    = process.cwd();
const session = await startSession(root, { scope: 'feature/auth', name: 'auth-session' });

const status  = await sessionStatus(root, { id: session.id });

await endSession(root, { id: session.id, note: 'Completed login endpoint' });
```

### Memory (BRAIN) operations

```ts
import { observeBrain, searchBrain, timelineBrain } from '@cleocode/core/memory';

const root = process.cwd();

await observeBrain(root, {
  text: 'Using bcrypt with cost factor 12 for password hashing',
  title: 'auth-password-hashing',
});

const results  = await searchBrain(root, { query: 'auth', limit: 5 });
const timeline = await timelineBrain(root, { limit: 20 });
```

### Facade (all-in-one)

```ts
import { Cleo } from '@cleocode/core/sdk';

async function main() {
  const cleo = await Cleo.init(process.cwd());

  try {
    const epic = await cleo.tasks.add({ title: 'Auth System', type: 'epic', priority: 'high' });

    const task = await cleo.tasks.add({
      title: 'Implement JWT validation',
      type: 'task',
      priority: 'high',
      parent: epic.data.id,
    });

    await cleo.sessions.start({ scope: 'feature/auth', name: 'auth-sprint' });

    await cleo.memory.observe({
      text: 'JWT validated via RS256 — symmetric HMAC rejected',
      title: 'jwt-algo-decision',
    });

    await cleo.tasks.complete({ taskId: task.data.id });
  } finally {
    await cleo.destroy();
  }
}

main().catch(console.error);
```

## Error handling

All functions return LAFS-compliant envelopes `{ success: boolean; data?: T; error?: E; meta: M }`.
Errors extend `CleoError` and carry a typed code from the `ERROR_CATALOG`:

```ts
import { CleoError } from '@cleocode/core';

try {
  await tasksShowOp(root, { taskId: 'T9999' });
} catch (err) {
  if (err instanceof CleoError) {
    console.error(err.code);    // e.g. 'E_NOT_FOUND'
    console.error(err.message); // human-readable description
  }
}
```

See [`@cleocode/contracts`](../contracts/README.md) for the full error catalog and `ExitCode` enum.

## Versioning policy

`@cleocode/core` uses **CalVer** (`YYYY.M.PATCH`) to express calendar-position compatibility with the CLEO CLI:

| Change class | Version impact |
|---|---|
| Non-breaking addition to a stable subpath | `PATCH` bump only |
| Breaking change to a **stable** subpath | CalVer **month bump** (`2026.5.x`) |
| Breaking change to an **internal** subpath | `PATCH` bump; documented in CHANGELOG |
| Removal of a deprecated symbol | Requires one-release-cycle advance notice in `STABILITY.md` |

If this package is ever forked as a standalone SDK (decoupled from the CLEO CLI release train), SemVer (`MAJOR.MINOR.PATCH`) will be adopted at that fork point with a major version bump. Until then, CalVer is canonical and the `PATCH` component carries no SemVer semantics.

## Architecture references

- [ADR-057: Contracts/Core SSoT layering — uniform `(projectRoot, params)` Core API](../../docs/adr/ADR-057-contracts-core-ssot.md)
- [ADR-058: Dispatch type inference via `OpsFromCore<C>`](../../docs/adr/ADR-058-dispatch-type-inference.md)
- [STABILITY.md](./STABILITY.md) — per-subpath stability tiers and breaking-change policy
- [`@cleocode/contracts`](../contracts/README.md) — all shared types (Params, Results, envelopes)

## Package boundary

`@cleocode/core` is the **SDK** — runtime primitives, domain logic, store, memory, sentient, and GC.

| Do | Do not |
|---|---|
| Import from `@cleocode/core/sdk` or narrow subpaths | Import from `@cleocode/core/internal` in third-party code |
| Use `@cleocode/contracts` types | Inline or mock types |
| Call `Cleo.init()` / domain ops | Access the SQLite store directly |

See the monorepo [AGENTS.md](../../AGENTS.md) for the full package-boundary contract.

## License

MIT — see [LICENSE](../../LICENSE) for details.
