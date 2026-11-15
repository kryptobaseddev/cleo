# @cleocode/core — CLEO SDK

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

CLEO's business logic **and canonical SDK surface**: tasks, sessions, evidence, memory (BRAIN), docs, orchestration, lifecycle and release, with the bundled SQLite store. The `cleo` CLI (`@cleocode/cleo`) is a thin dispatcher over this package.

> **`@cleocode/core` IS the CLEO SDK.** There is no separate `@cleocode/cleo-sdk` package. The `Cleo` facade, domain namespaces, and flat free functions are exposed through per-subpath exports that follow a CalVer stability contract. See [STABILITY.md](./STABILITY.md) for the contract and `.dts-snapshots/` for the enforced baseline.

CLEO has no agent loop: agents run in their own harness and call CLEO. For agents and SDK consumers calling core operations directly (no CLI subprocess), see the **[CORE API Agent Guide](../../docs/reference/core-sdk.md)**.

## Quickstart

```ts
import { addTask, startSession } from '@cleocode/core';

const projectRoot = process.cwd();

// Mutations need an active session
await startSession(projectRoot, { scope: 'global', name: 'my-session' });

// Only a saga may be a root: file tasks under an existing epic.
// By default a task needs at least 3 acceptance criteria.
const { task } = await addTask(
  {
    title: 'My task',
    type: 'task',
    parentId: 'T002',
    acceptance: ['first criterion', 'second criterion', 'third criterion'],
  },
  projectRoot,
);
```

Or use the `Cleo` facade for a project-bound, domain-grouped interface:

```ts
import { Cleo } from '@cleocode/core/sdk';

const cleo = await Cleo.init(process.cwd());

await cleo.sessions.start({ scope: 'global', name: 'my-session' });
await cleo.tasks.add({
  title: 'My task',
  type: 'task',
  parent: 'T002',
  acceptance: ['first criterion', 'second criterion', 'third criterion'],
});
await cleo.memory.observe({ text: 'Chose RS256 for JWT validation', title: 'jwt-algo-decision' });
await cleo.sessions.end({ note: 'Filed the task' });
```

The facade's methods are typed `Promise<unknown>` in `@cleocode/contracts` (`facade.ts`); call the flat functions when you need typed results.

## Installation

```bash
# npm
npm install @cleocode/core

# pnpm (recommended)
pnpm add @cleocode/core

# yarn
yarn add @cleocode/core
```

**Node.js requirement**: `>=24.16.0`

## Dispatch domains

The CLI dispatches 28 domains, listed in `CANONICAL_DOMAINS` (`packages/contracts/src/dispatch/identity.ts`). Their core operations follow the uniform `(projectRoot: string, params: <Op>Params) => Promise<<Op>Result>` signature mandated by [ADR-057](../../docs/adr/adr-057-contracts-core-ssot.md). The op wrappers (`tasksAddOp`, `tasksShowOp`, …) are exported from `@cleocode/core/internal` for the CLI; third-party code uses the subpaths below.

## Subpath exports

Prefer the **narrowest** subpath that satisfies your need: it reduces import cost and is covered by snapshot-enforced stability gates.

| Subpath | Tier | Use when |
|---------|------|----------|
| `@cleocode/core/sdk` | stable | External agents, Studio panels — `Cleo` facade only |
| `@cleocode/core/tasks` | stable | Task CRUD, hierarchy, graph ops |
| `@cleocode/core/sessions` | stable | Session lifecycle, briefing, handoff |
| `@cleocode/core/memory` | stable | Research entries and the agent-output manifest (the BRAIN functions are on the root export) |
| `@cleocode/core/nexus` | stable | Project registry and cross-project queries |
| `@cleocode/core/lifecycle` | stable | RCASD-IVTR stage transitions and gate enforcement |
| `@cleocode/core/harness` | stable | Spawn-provider selection (`selectHarnessSpawnProvider`) |
| `@cleocode/core/gc` | stable | Transcript cleanup, disk-pressure checks, GC state |
| `@cleocode/core/contracts` | stable | Pure `@cleocode/contracts` re-export (types only) |
| `@cleocode/core` | stable | All namespaces + flat free functions, including BRAIN (`observeBrain`, `searchBrain`, `timelineBrain`) |
| `@cleocode/core/internal` | **internal** | CLI dispatch only — do NOT import from third-party code |

Two subpaths remain only for existing callers; do not build on them:

- `@cleocode/core/conduit` — the legacy Conduit messaging client, retiring (T13933). AgentMBX is CLEO's messaging layer (D11176).
- `@cleocode/core/sentient` — the sentient loop API (tick, Tier-2 proposals). ADR-098 (`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`) replaces its spawning loops with CLEO Goal (ADR-097), the one autonomous driver, and retires the sentient subsystem host.

`package.json` `exports` is the full list (it also exposes wildcard paths such as `./tasks/*`). See [STABILITY.md](./STABILITY.md) for the tier definitions and breaking-change policy.

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
import { addTask, completeTask, listTasks, showTask } from '@cleocode/core';

const root = process.cwd();

const { task } = await addTask(
  {
    title: 'Implement login endpoint',
    type: 'task',
    priority: 'high',
    size: 'medium',
    parentId: 'T1000',          // the epic it belongs to
    depends: ['T1001'],         // optional dependency list
    acceptance: ['returns a token', 'rejects bad passwords', 'a test covers both'],
  },
  root,
);

const detail = await showTask(task.id, root);
const list   = await listTasks({ status: 'pending' }, root);
await completeTask({ taskId: task.id }, root);
```

Completing a task still passes CLEO's evidence gates (ADR-051); record them first (`cleo done <id> --plan`).

### Session operations

```ts
import { endSession, sessionStatus, startSession } from '@cleocode/core';

const root = process.cwd();

await startSession(root, { scope: 'epic:T1234', name: 'auth-session' });
const current = await sessionStatus(root, {});
await endSession(root, { note: 'Completed login endpoint' });
```

### Memory (BRAIN) operations

```ts
import { observeBrain, searchBrain } from '@cleocode/core';

const root = process.cwd();

await observeBrain(root, {
  text: 'Using bcrypt with cost factor 12 for password hashing',
  title: 'auth-password-hashing',
});

const results = await searchBrain(root, 'auth', { limit: 5 });
```

`timelineBrain(root, { anchor: '<entry id>' })` returns the entries around one anchor entry.

## Error handling

Core functions return plain results and throw `CleoError` on failure. A `CleoError` carries a numeric `code` (an `ExitCode`), an optional `codeName`, and usually a `fix` hint; `ERROR_CATALOG` maps each code to its definition:

```ts
import { CleoError, showTask } from '@cleocode/core';

try {
  await showTask('T9999', process.cwd());
} catch (err) {
  if (err instanceof CleoError) {
    console.error(err.code);    // e.g. 4 (ExitCode.NOT_FOUND)
    console.error(err.message); // human-readable description
    console.error(err.fix);     // how to recover, when known
  }
}
```

The CLI wraps these results and errors in LAFS envelopes. See [`@cleocode/contracts`](../contracts/README.md) for the `ExitCode` enum.

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

- [ADR-057: Contracts/Core SSoT layering — uniform `(projectRoot, params)` Core API](../../docs/adr/adr-057-contracts-core-ssot.md)
- [ADR-058: Dispatch type inference via `OpsFromCore<C>`](../../docs/adr/adr-058-dispatch-type-inference.md)
- ADR-098: CLEO is a harness-agnostic core (`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`; no `docs/adr/` mirror yet)
- [CLEO architecture guide](../../docs/concept/cleo-architecture-guide.md)
- [STABILITY.md](./STABILITY.md) — per-subpath stability tiers and breaking-change policy
- [`@cleocode/contracts`](../contracts/README.md) — all shared types (Params, Results, envelopes)

## Package boundary

`@cleocode/core` is the **SDK** — runtime primitives, domain logic, store, memory and GC.

| Do | Do not |
|---|---|
| Import from `@cleocode/core/sdk` or narrow subpaths | Import from `@cleocode/core/internal` in third-party code |
| Use `@cleocode/contracts` types | Inline or mock types |
| Call `Cleo.init()` / domain functions | Access the SQLite store directly |

See the monorepo [AGENTS.md](../../AGENTS.md) for the full package-boundary contract.

## License

MIT — see [LICENSE](../../LICENSE) for details.
